#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phetSimulations } from "../src/phetCatalog.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const batch = readArg("--batch", "phase1");
const destinationValue = readArg("--dest", path.join(projectRoot, "public", "simulations", "phet"));
const linkDistValue = readArg("--link-dist");
if (
  process.platform === "win32" &&
  ([destinationValue, linkDistValue].some((value) => value.startsWith("/var/")))
) {
  throw new Error("服务器部署路径只能在Linux服务器上使用，请在服务器执行 npm run phet:deploy。");
}
const destination = path.resolve(destinationValue);
const linkDist = linkDistValue ? path.resolve(linkDistValue) : "";
const checkOnly = process.argv.includes("--check");
const force = process.argv.includes("--force");
const statePath = path.join(destination, "phet-sync-state.json");

const simulations = phetSimulations.filter((simulation) => simulation.batch === batch && simulation.sourceUrl);

if (simulations.length === 0) {
  throw new Error(`没有找到批次 ${batch} 的 PhET 模拟。`);
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { version: 1, simulations: {} };
  }
}

function validateDownloadedHtml(buffer, simulation) {
  const beginning = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  if (!beginning.includes("<!DOCTYPE html") && !beginning.includes("<html")) {
    throw new Error(`${simulation.id} 下载结果不是HTML文件。`);
  }
  if (!buffer.includes(Buffer.from("phet.chipper"))) {
    throw new Error(`${simulation.id} 缺少PhET运行标识。`);
  }
}

async function getRemoteInfo(simulation) {
  const response = await fetch(simulation.sourceUrl, { method: "HEAD", redirect: "follow" });
  if (!response.ok) throw new Error(`${simulation.id} 检查失败：HTTP ${response.status}`);
  return {
    lastModified: response.headers.get("last-modified") || "",
    etag: response.headers.get("etag") || "",
  };
}

async function fetchSimulation(simulation, targetPath, writeFile) {
  const response = await fetch(simulation.sourceUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`${simulation.id} 下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  validateDownloadedHtml(buffer, simulation);

  if (writeFile) {
    const temporaryPath = `${targetPath}.part`;
    fs.writeFileSync(temporaryPath, buffer);
    fs.renameSync(temporaryPath, targetPath);
  }

  return {
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    lastModified: response.headers.get("last-modified") || "",
    etag: response.headers.get("etag") || "",
  };
}

function installDistLink() {
  if (!linkDist) return;

  const expectedSuffix = path.join("dist", "simulations", "phet").toLowerCase();
  if (!linkDist.toLowerCase().endsWith(expectedSuffix)) {
    throw new Error(`拒绝修改不安全的链接路径：${linkDist}`);
  }

  fs.mkdirSync(path.dirname(linkDist), { recursive: true });
  try {
    fs.lstatSync(linkDist);
    fs.rmSync(linkDist, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.symlinkSync(destination, linkDist, process.platform === "win32" ? "junction" : "dir");
  console.log(`[link] ${linkDist} -> ${destination}`);
}

async function main() {
  fs.mkdirSync(destination, { recursive: true });
  const state = readState();
  let totalBytes = 0;
  let downloaded = 0;
  let skipped = 0;

  console.log(`PhET批次：${batch}`);
  console.log(`模拟数量：${simulations.length}`);
  console.log(`${checkOnly ? "检查" : "保存"}目录：${destination}`);

  for (const simulation of simulations) {
    const targetPath = path.join(destination, `${simulation.id}.html`);
    const previous = state.simulations?.[simulation.id] || {};
    let remote = {};

    if (!force && !checkOnly && fs.existsSync(targetPath)) {
      try {
        remote = await getRemoteInfo(simulation);
        if (
          previous.sourceUrl === simulation.sourceUrl &&
          previous.lastModified &&
          previous.lastModified === remote.lastModified
        ) {
          const bytes = fs.statSync(targetPath).size;
          totalBytes += bytes;
          skipped += 1;
          console.log(`[skip] ${simulation.id} ${formatMiB(bytes)}`);
          continue;
        }
      } catch (error) {
        console.warn(`[warn] ${error.message}，保留现有文件并继续。`);
        const bytes = fs.statSync(targetPath).size;
        totalBytes += bytes;
        skipped += 1;
        continue;
      }
    }

    const result = await fetchSimulation(simulation, targetPath, !checkOnly);
    totalBytes += result.bytes;
    downloaded += 1;
    console.log(`[${checkOnly ? "check" : "download"}] ${simulation.id} ${formatMiB(result.bytes)}`);

    if (!checkOnly) {
      state.simulations = state.simulations || {};
      state.simulations[simulation.id] = {
        sourceUrl: simulation.sourceUrl,
        bytes: result.bytes,
        sha256: result.sha256,
        lastModified: result.lastModified || remote.lastModified || "",
        etag: result.etag || remote.etag || "",
        syncedAt: new Date().toISOString(),
      };
    }
  }

  if (!checkOnly) {
    state.version = 1;
    state.batch = batch;
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    installDistLink();
  }

  console.log(`完成：${downloaded} 个${checkOnly ? "已检查" : "已下载"}，${skipped} 个未变更，总计 ${formatMiB(totalBytes)}。`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
