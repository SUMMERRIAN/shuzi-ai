import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import { ensureSchema } from "./schema.js";
import { query, withTransaction } from "./db.js";
import { requireAdminToken, requireAuth, signToken } from "./auth.js";
import { ltPackages, membershipPlans, storageExpansionPackages, tokenBillingRules } from "./plans.js";
import { upload, toStoredFile } from "./uploads.js";
import { ensureGeminiKey, generateGeminiText } from "./geminiClient.js";
import { ensureOpenAIKey, getGeneratedImageBase64, getResponseText, openai, parseJsonText, readFileAsDataUrl } from "./openaiClient.js";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: "5mb" }));

const textModel = process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL_THINKING || "gpt-5";
const openaiFastModel = process.env.OPENAI_MODEL_FAST || process.env.OPENAI_MODEL_TEXT || textModel;
const openaiThinkingModel = process.env.OPENAI_MODEL_THINKING || process.env.OPENAI_MODEL_TEXT || textModel;
const geminiFastModel = process.env.GEMINI_MODEL_FAST || "gemini-2.5-flash";
const geminiThinkingModel = process.env.GEMINI_MODEL_THINKING || "gemini-2.5-pro";
const imageModel = process.env.OPENAI_MODEL_IMAGE || "gpt-image-2";
const transcriptionModel = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe";

const knowledgeInfographicTemplate = `超精细教育信息图 [SUBJECT]，
科学教科书插画风格，
干净的学术学习版式，
高度整理的学习笔记美学，
带有虚线引导的结构注释图，
物体周围带有多个教育说明标签，
适合学生阅读的清晰视觉层级，
教材风格，
科学课堂海报设计，
教育用途的结构注释与组件标注，
手写笔记感与现代信息图设计结合，
适合学生理解的可视化讲解，
分步骤结构拆解，
悬浮式标签与指示箭头，
点状连接虚线，
精准的科学可视化表现，
居中构图，
纯白干净背景，
柔和粉彩配色，
高可读性，
现代教育出版物风格，
干净留白边距，
3D 科学渲染，
Octane Render 渲染风格，
次表面散射（Subsurface Scattering），
超高细节纹理，
电影级灯光，
视觉化学习设计，
教育海报美学。`;

function normalizeAiProvider(provider = "") {
  return String(provider).toLowerCase() === "gemini" ? "gemini" : "openai";
}

function normalizeAiMode(mode = "") {
  return String(mode).toLowerCase() === "thinking" ? "thinking" : "fast";
}

function getOpenAITextModel(mode = "fast") {
  return normalizeAiMode(mode) === "thinking" ? openaiThinkingModel : openaiFastModel;
}

function getGeminiModel(mode = "fast") {
  return normalizeAiMode(mode) === "thinking" ? geminiThinkingModel : geminiFastModel;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

function normalizeIdentifier(identifier = "") {
  return String(identifier).trim().toLowerCase();
}

const freeStorageMb = Number(membershipPlans.free?.storageMb || 50);

function createHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function mergeMeta(current, patch) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return JSON.stringify({ ...base, ...patch });
}

function parsePaymentMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "object" && !Array.isArray(meta)) return meta;
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toPublicUser(row) {
  return {
    id: row.id,
    channel: row.channel,
    identifier: row.identifier,
    provider: row.provider,
    displayName: row.display_name,
    role: row.role,
  };
}

async function getOrCreateStudent(client, user, name = "") {
  const existing = await client.query("SELECT * FROM students WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1", [user.id]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await client.query(
    "INSERT INTO students (user_id, name) VALUES ($1, $2) RETURNING *",
    [user.id, name || user.display_name || "未命名学生"]
  );
  return created.rows[0];
}

async function ensureAccountRows(client, user, student) {
  await client.query(
    `INSERT INTO student_memberships (user_id, student_id, plan_id, plan_name, status)
     SELECT $1, $2, 'free', '免费用户', 'free'
     WHERE NOT EXISTS (SELECT 1 FROM student_memberships WHERE user_id = $1)`,
    [user.id, student.id]
  );
  await client.query(
    `INSERT INTO learning_token_wallets (user_id, balance, reserved)
     VALUES ($1, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );
  await client.query(
    `INSERT INTO storage_quotas (user_id, base_mb, expansion_mb, used_bytes)
     VALUES ($1, 50, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );
}

async function getPrimaryStudent(user) {
  return withTransaction(async (client) => {
    const student = await getOrCreateStudent(client, user);
    await ensureAccountRows(client, user, student);
    return student;
  });
}

async function assertPaidMember(userId) {
  await expireOutdatedMemberships(userId);
  const membership = (
    await query("SELECT * FROM student_memberships WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId])
  ).rows[0];
  const isPaid =
    membership?.status === "active" &&
    (!membership.expires_at || new Date(membership.expires_at).getTime() > Date.now());
  if (!isPaid) {
    const error = new Error("此功能需要开通会员。");
    error.status = 402;
    error.code = "MEMBERSHIP_REQUIRED";
    throw error;
  }
}

async function expireOutdatedMemberships(userId = null) {
  const params = [];
  let scope = "";
  if (userId) {
    params.push(userId);
    scope = "AND user_id = $1";
  }
  await query(
    `UPDATE student_memberships
     SET status = 'expired', updated_at = now()
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= now()
       ${scope}`,
    params
  );
  await query(
    `UPDATE storage_quotas q
     SET base_mb = $${params.length + 1}, updated_at = now()
     WHERE ${userId ? "q.user_id = $1 AND" : ""}
       NOT EXISTS (
         SELECT 1
         FROM student_memberships sm
         WHERE sm.user_id = q.user_id
           AND sm.status = 'active'
           AND (sm.expires_at IS NULL OR sm.expires_at > now())
       )
       AND q.base_mb <> $${params.length + 1}`,
    [...params, freeStorageMb]
  );
}

function getMembershipWindow(startDate, durationDays) {
  const rawStart = String(startDate || "").trim();
  const start = rawStart ? new Date(`${rawStart}T00:00:00+08:00`) : new Date();
  const startedAt = Number.isNaN(start.getTime()) ? new Date() : start;
  const days = Math.max(1, Number(durationDays || 31));
  const expiresAt = new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000);
  return { startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(), days };
}

async function recordTokenUsage(userId, amount, note, meta = {}) {
  const tokens = Math.max(1, Math.ceil(Number(amount || 1)));
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO learning_token_wallets (user_id, balance, reserved)
       VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const wallet = (
      await client.query("SELECT balance FROM learning_token_wallets WHERE user_id = $1 FOR UPDATE", [userId])
    ).rows[0];
    if (Number(wallet?.balance || 0) < tokens) {
      throw createHttpError(402, "INSUFFICIENT_TOKENS", "Token余额不足，请充值后再使用AI功能。");
    }
    await client.query("UPDATE learning_token_wallets SET balance = balance - $2, updated_at = now() WHERE user_id = $1", [userId, tokens]);
    await client.query(
      `INSERT INTO learning_token_transactions (user_id, amount, type, source, note, meta)
       VALUES ($1, $2, 'consume', 'ai_action', $3, $4)`,
      [userId, -tokens, note, JSON.stringify(meta)]
    );
  });
}

async function assertTokenBalance(userId, amount) {
  const tokens = Math.max(1, Math.ceil(Number(amount || 1)));
  const wallet = (
    await query("SELECT balance FROM learning_token_wallets WHERE user_id = $1", [userId])
  ).rows[0];
  if (Number(wallet?.balance || 0) < tokens) {
    throw createHttpError(402, "INSUFFICIENT_TOKENS", "Token余额不足，请充值后再使用AI功能。");
  }
}

async function saveUploadedFiles(client, user, student, purpose, files) {
  const saved = [];
  const incomingBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (incomingBytes > 0) {
    await expireOutdatedMemberships(user.id);
    await client.query(
      `INSERT INTO storage_quotas (user_id, base_mb, expansion_mb, used_bytes)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, freeStorageMb]
    );
    const storage = (await client.query("SELECT * FROM storage_quotas WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
    const totalBytes = (Number(storage?.base_mb || freeStorageMb) + Number(storage?.expansion_mb || 0)) * 1024 * 1024;
    const nextUsedBytes = Number(storage?.used_bytes || 0) + incomingBytes;
    if (nextUsedBytes > totalBytes) {
      for (const file of files) {
        if (file?.path) fs.promises.unlink(file.path).catch(() => {});
      }
      throw createHttpError(413, "STORAGE_QUOTA_EXCEEDED", "存储空间不足，请清理资料或开通会员/扩容后再上传。");
    }
  }
  for (const file of files) {
    const stored = toStoredFile(file);
    const result = await client.query(
      `INSERT INTO uploaded_files (student_id, user_id, purpose, original_name, stored_name, path, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [student.id, user.id, purpose, stored.originalName, stored.filename, stored.path, stored.mimeType, stored.size]
    );
    saved.push(result.rows[0]);
  }
  if (saved.length) {
    const usedBytes = saved.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
    await client.query("UPDATE storage_quotas SET used_bytes = used_bytes + $2, updated_at = now() WHERE user_id = $1", [
      user.id,
      usedBytes,
    ]);
  }
  return saved;
}

function toFileSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: row.created_at,
    downloadUrl: `/api/files/${row.id}/download`,
  };
}

function toCalendarEvent(row) {
  return {
    id: row.id,
    eventDate: row.event_date,
    title: row.title,
    content: row.content || "",
    files: Array.isArray(row.files) ? row.files.filter(Boolean) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLibraryItem(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    type: row.item_type,
    name: row.name,
    fileId: row.file_id,
    content: row.content || "",
    notes: row.notes || "",
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    isStarred: Boolean(row.is_starred),
    isTrashed: Boolean(row.is_trashed),
    downloadUrl: row.file_id ? `/api/files/${row.file_id}/download` : "",
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeImageInputs(files) {
  return files
    .filter((file) => (file.mimetype || "").startsWith("image/"))
    .slice(0, 6)
    .map((file) => ({
      type: "input_image",
      image_url: readFileAsDataUrl(file),
    }));
}

async function extractDocumentText(file) {
  const mime = file.mimetype || "";
  const name = (file.originalname || "").toLowerCase();
  try {
    if (mime.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".csv")) {
      return fs.readFileSync(file.path, "utf8").slice(0, 12000);
    }
    if (name.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ path: file.path });
      return (result.value || "").slice(0, 12000);
    }
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(file.path);
      return workbook.worksheets
        .map((sheet) => {
          const rows = [];
          sheet.eachRow((row) => {
            rows.push(row.values.slice(1).map((value) => (value == null ? "" : String(value))).join(","));
          });
          return `【${sheet.name}】\n${rows.join("\n")}`;
        })
        .join("\n\n")
        .slice(0, 12000);
    }
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const text = await extractPdfText(fs.readFileSync(file.path));
      return text.slice(0, 12000);
    }
  } catch (error) {
    console.warn("Failed to extract uploaded document text", file.originalname, error.message);
  }
  return "";
}

async function makeDocumentTextSummary(files) {
  const chunks = [];
  for (const file of files) {
    if ((file.mimetype || "").startsWith("image/")) continue;
    const text = await extractDocumentText(file);
    chunks.push(`文件：${file.originalname}\n类型：${file.mimetype || "未知"}\n内容摘录：\n${text || "暂时无法自动提取文字，请根据文件名和学生说明进行保守分析。"}`);
  }
  return chunks.join("\n\n---\n\n").slice(0, 30000);
}

function jsonInstruction(schemaDescription) {
  return `请只输出严格 JSON，不要 Markdown，不要额外解释。JSON结构：${schemaDescription}`;
}

async function buildAccountSnapshot(userId) {
  await expireOutdatedMemberships(userId);
  const userResult = await query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = userResult.rows[0];
  const student = (await query("SELECT * FROM students WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1", [userId])).rows[0];
  const membership = (
    await query("SELECT * FROM student_memberships WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId])
  ).rows[0];
  const wallet = (await query("SELECT * FROM learning_token_wallets WHERE user_id = $1", [userId])).rows[0];
  const storage = (await query("SELECT * FROM storage_quotas WHERE user_id = $1", [userId])).rows[0];
  const isPaid =
    membership?.status === "active" &&
    (!membership.expires_at || new Date(membership.expires_at).getTime() > Date.now());
  const expiresAtMs = membership?.expires_at ? new Date(membership.expires_at).getTime() : null;
  const daysRemaining = expiresAtMs ? Math.ceil((expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  const effectiveBaseMb = isPaid ? Number(storage?.base_mb || membershipPlans.monthly.storageMb || 3072) : freeStorageMb;
  const expansionMb = Number(storage?.expansion_mb || 0);
  return {
    user: toPublicUser(user),
    student: student
      ? {
          id: student.id,
          name: student.name,
          grade: student.grade,
          stage: student.stage,
          profileStatus: student.profile_status,
        }
      : null,
    membership: {
      planId: membership?.plan_id || "free",
      planName: membership?.plan_name || "免费用户",
      status: membership?.status || "free",
      isPaid,
      startedAt: membership?.started_at || null,
      expiresAt: membership?.expires_at || null,
      daysRemaining,
      isExpiringSoon: isPaid && daysRemaining !== null && daysRemaining <= 7,
    },
    wallet: {
      balance: wallet?.balance || 0,
      reserved: wallet?.reserved || 0,
    },
    storage: {
      baseMb: effectiveBaseMb,
      expansionMb,
      usedBytes: Number(storage?.used_bytes || 0),
      totalMb: effectiveBaseMb + expansionMb,
    },
  };
}

app.get("/api/health", async (req, res) => {
  await query("SELECT 1");
  res.json({ ok: true, service: "shuzi-ai-api" });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password, displayName = "" } = req.body || {};
  const normalized = normalizeIdentifier(username);
  if (!normalized || normalized.length < 3) {
    return res.status(400).json({ error: "USERNAME_REQUIRED", message: "用户名至少需要3个字符。" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "PASSWORD_REQUIRED", message: "密码至少需要6位。" });
  }

  const result = await withTransaction(async (client) => {
    const existing = await client.query("SELECT id FROM users WHERE identifier = $1", [normalized]);
    if (existing.rows[0]) {
      const error = new Error("这个用户名已经被使用，请换一个用户名。");
      error.status = 409;
      error.code = "USERNAME_EXISTS";
      throw error;
    }
    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = (
      await client.query(
        `INSERT INTO users (channel, identifier, provider, display_name, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        ["username", normalized, "用户名密码", displayName || normalized, passwordHash]
      )
    ).rows[0];
    const student = await getOrCreateStudent(client, user, displayName);
    await ensureAccountRows(client, user, student);
    return user;
  });

  res.json({ token: signToken(result), account: await buildAccountSnapshot(result.id) });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const normalized = normalizeIdentifier(username);
  const result = await query("SELECT * FROM users WHERE identifier = $1", [normalized]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND", message: "账号不存在，请先注册。" });
  const isValid = user.password_hash ? await bcrypt.compare(String(password || ""), user.password_hash) : false;
  if (!isValid) return res.status(401).json({ error: "INVALID_PASSWORD", message: "用户名或密码不正确。" });
  res.json({ token: signToken(user), account: await buildAccountSnapshot(user.id) });
});

app.get("/api/me", requireAuth, async (req, res) => {
  res.json({ account: await buildAccountSnapshot(req.user.id) });
});

app.get("/api/membership/plans", (req, res) => {
  res.json({
    membershipPlans: Object.values(membershipPlans),
    ltPackages: Object.values(ltPackages),
    storageExpansionPackages: Object.values(storageExpansionPackages),
  });
});

app.post("/api/admin/login", async (req, res) => {
  const { username = "", password = "" } = req.body || {};
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const adminToken = process.env.ADMIN_SETUP_TOKEN;
  if (!expectedUsername || !expectedPassword || !adminToken) {
    return res.status(503).json({ error: "ADMIN_NOT_CONFIGURED", message: "管理员账号还没有在服务器环境变量中配置。" });
  }
  if (String(username).trim() !== expectedUsername || String(password) !== expectedPassword) {
    return res.status(401).json({ error: "ADMIN_LOGIN_FAILED", message: "管理员账号或密码不正确。" });
  }
  res.json({ adminToken });
});

app.post("/api/membership/orders", requireAuth, async (req, res) => {
  const { planId = "monthly" } = req.body || {};
  const plan = membershipPlans[planId];
  if (!plan || plan.id === "free") return res.status(400).json({ error: "INVALID_PLAN" });
  const order = (
    await query(
      `INSERT INTO payment_orders (user_id, order_type, package_id, title, amount_cny, provider, meta)
       VALUES ($1, 'membership', $2, $3, $4, 'manual', $5)
       RETURNING *`,
      [req.user.id, plan.id, plan.name, plan.priceCny, JSON.stringify({ durationDays: plan.durationDays })]
    )
  ).rows[0];
  res.json({
    order,
    message: "已生成会员开通申请。当前版本需要管理员后台手动确认后开通。",
  });
});

app.post("/api/lt/orders", requireAuth, async (req, res) => {
  const { packageId, customAmount } = req.body || {};
  const amountCny = Number(customAmount || 0);
  if (packageId === "custom" && amountCny < 50) {
    return res.status(400).json({ error: "LT_MIN_AMOUNT", message: "自定义充值金额最低为50元。" });
  }
  const pack = packageId === "custom"
    ? { id: "custom", title: `Token自定义充值 ¥${amountCny}`, priceCny: amountCny, learningTokens: Math.round(amountCny * tokenBillingRules.tokensPerCny) }
    : ltPackages[packageId];
  if (!pack || Number(pack.priceCny) <= 0) return res.status(400).json({ error: "INVALID_LT_PACKAGE" });
  const order = (
    await query(
      `INSERT INTO payment_orders (user_id, order_type, package_id, title, amount_cny, provider, meta)
       VALUES ($1, 'lt_recharge', $2, $3, $4, 'manual', $5)
       RETURNING *`,
      [req.user.id, pack.id, pack.title, pack.priceCny, JSON.stringify({ learningTokens: pack.learningTokens })]
    )
  ).rows[0];
  res.json({ order, message: "已生成LT充值申请。当前版本需要管理员后台手动确认。" });
});

app.get("/api/account/center", requireAuth, async (req, res) => {
  const account = await buildAccountSnapshot(req.user.id);
  const downloads = (
    await query(
      `SELECT id, title, payload, created_at
       FROM student_archive_events
       WHERE user_id = $1 AND event_type = 'download'
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    )
  ).rows;
  const tokenRecords = (
    await query(
      `SELECT id, amount, type, source, note, meta, created_at
       FROM learning_token_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    )
  ).rows;
  const orders = (
    await query(
      `SELECT id, order_type, package_id, title, amount_cny, status, provider, meta, created_at, paid_at, updated_at
       FROM payment_orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    )
  ).rows;
  res.json({ account, downloads, tokenRecords, orders });
});

app.post("/api/account/profile", requireAuth, async (req, res) => {
  const { displayName = "" } = req.body || {};
  const name = String(displayName).trim();
  if (!name) return res.status(400).json({ error: "NAME_REQUIRED", message: "请输入学生姓名或昵称。" });
  await withTransaction(async (client) => {
    await client.query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1", [req.user.id, name]);
    const student = await getOrCreateStudent(client, req.user, name);
    await client.query("UPDATE students SET name = $2, updated_at = now() WHERE id = $1", [student.id, name]);
  });
  res.json({ account: await buildAccountSnapshot(req.user.id) });
});

app.post("/api/account/password", requireAuth, async (req, res) => {
  const { oldPassword = "", newPassword = "" } = req.body || {};
  const user = (await query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
  const ok = user.password_hash ? await bcrypt.compare(String(oldPassword), user.password_hash) : false;
  if (!ok) return res.status(401).json({ error: "INVALID_PASSWORD", message: "原密码不正确。" });
  if (String(newPassword).length < 6) return res.status(400).json({ error: "PASSWORD_TOO_SHORT", message: "新密码至少需要6位。" });
  const passwordHash = await bcrypt.hash(String(newPassword), 12);
  await query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [req.user.id, passwordHash]);
  res.json({ ok: true });
});

app.post("/api/account/downloads", requireAuth, async (req, res) => {
  const { title = "资料下载", filename = "", href = "" } = req.body || {};
  const student = await getPrimaryStudent(req.user);
  const event = (
    await query(
      `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
       VALUES ($1, $2, 'download', $3, $4)
       RETURNING *`,
      [student.id, req.user.id, title, JSON.stringify({ filename, href })]
    )
  ).rows[0];
  res.json({ event });
});

app.post("/api/archive/questionnaire", requireAuth, async (req, res) => {
  const { answers = {}, completion = 0, status = "draft" } = req.body || {};
  const saved = await withTransaction(async (client) => {
    const student = await getOrCreateStudent(client, req.user, answers.name);
    await ensureAccountRows(client, req.user, student);
    const record = (
      await client.query(
        `INSERT INTO student_intake_questionnaires (student_id, user_id, answers, completion, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [student.id, req.user.id, JSON.stringify(answers), completion, status]
      )
    ).rows[0];
    await client.query(
      `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
       VALUES ($1, $2, 'questionnaire', $3, $4)`,
      [student.id, req.user.id, status === "submitted" ? "提交学情问卷" : "保存学情问卷草稿", JSON.stringify({ completion, answers })]
    );
    return record;
  });
  res.json({ saved });
});

app.post("/api/archive/statements", requireAuth, async (req, res) => {
  const { subject = "", scene = "", intensity = null, content = "", guidedAnswers = {} } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: "CONTENT_REQUIRED" });
  const saved = await withTransaction(async (client) => {
    const student = await getOrCreateStudent(client, req.user);
    await ensureAccountRows(client, req.user, student);
    const record = (
      await client.query(
        `INSERT INTO student_statements (student_id, user_id, subject, scene, intensity, content, guided_answers)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [student.id, req.user.id, subject, scene, intensity, content, JSON.stringify(guidedAnswers)]
      )
    ).rows[0];
    await client.query(
      `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
       VALUES ($1, $2, 'statement', $3, $4)`,
      [student.id, req.user.id, `${subject || "学习"}陈述`, JSON.stringify({ subject, scene, intensity, content, guidedAnswers })]
    );
    return record;
  });
  res.json({ saved });
});

app.get("/api/archive", requireAuth, async (req, res) => {
  const student = (await query("SELECT * FROM students WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1", [req.user.id])).rows[0];
  if (!student) return res.json({ events: [] });
  const events = (
    await query("SELECT * FROM student_archive_events WHERE student_id = $1 ORDER BY created_at DESC LIMIT 100", [student.id])
  ).rows;
  res.json({ events });
});

app.get("/api/files/:id/download", requireAuth, async (req, res, next) => {
  try {
    const file = (await query("SELECT * FROM uploaded_files WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id])).rows[0];
    if (!file) return res.status(404).json({ error: "FILE_NOT_FOUND" });
    if (!fs.existsSync(file.path)) return res.status(404).json({ error: "FILE_MISSING" });
    res.download(file.path, file.original_name);
  } catch (error) {
    next(error);
  }
});

app.get("/api/calendar/events", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT e.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', f.id,
                'originalName', f.original_name,
                'mimeType', f.mime_type,
                'sizeBytes', f.size_bytes,
                'createdAt', f.created_at,
                'downloadUrl', CONCAT('/api/files/', f.id, '/download')
              )
            ) FILTER (WHERE f.id IS NOT NULL),
            '[]'::json
          ) AS files
         FROM learning_calendar_events e
         LEFT JOIN uploaded_files f ON f.id = ANY(e.file_ids)
         WHERE e.student_id = $1 AND e.user_id = $2
         GROUP BY e.id
         ORDER BY e.event_date ASC, e.created_at ASC`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({ events: rows.map(toCalendarEvent) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/calendar/events", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { eventDate = "", title = "", content = "" } = req.body || {};
    if (!eventDate || !title.trim()) return res.status(400).json({ error: "EVENT_REQUIRED" });
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "calendar", req.files || []);
      const event = (
        await client.query(
          `INSERT INTO learning_calendar_events (student_id, user_id, event_date, title, content, file_ids)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, eventDate, title.trim(), content || "", fileRows.map((file) => file.id)]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'calendar_event', $3, $4)`,
        [student.id, req.user.id, title.trim(), JSON.stringify({ eventDate, content, fileIds: fileRows.map((file) => file.id) })]
      );
      return { event, fileRows };
    });
    res.json({ event: toCalendarEvent({ ...saved.event, files: saved.fileRows.map(toFileSummary) }) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/calendar/events/:id", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { eventDate, title, content } = req.body || {};
    const saved = await withTransaction(async (client) => {
      const existing = (await client.query("SELECT * FROM learning_calendar_events WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id])).rows[0];
      if (!existing) return null;
      const fileRows = await saveUploadedFiles(client, req.user, student, "calendar", req.files || []);
      const nextFileIds = [...(existing.file_ids || []), ...fileRows.map((file) => file.id)];
      const event = (
        await client.query(
          `UPDATE learning_calendar_events
           SET event_date = COALESCE($3, event_date),
               title = COALESCE(NULLIF($4, ''), title),
               content = COALESCE($5, content),
               file_ids = $6,
               updated_at = now()
           WHERE id = $1 AND user_id = $2
           RETURNING *`,
          [req.params.id, req.user.id, eventDate || null, title || "", content ?? null, nextFileIds]
        )
      ).rows[0];
      return { event, fileRows };
    });
    const event = saved?.event;
    if (!event) return res.status(404).json({ error: "EVENT_NOT_FOUND" });
    const fileRows = (
      await query("SELECT * FROM uploaded_files WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC", [event.file_ids || []])
    ).rows;
    res.json({ event: toCalendarEvent({ ...event, files: fileRows.map(toFileSummary) }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/calendar/events/:id", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    await query("DELETE FROM learning_calendar_events WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/items", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const view = String(req.query.view || "drive");
    const folderId = req.query.folderId || null;
    const search = String(req.query.search || "").trim();
    const sort = String(req.query.sort || "name");
    const dir = String(req.query.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const clauses = ["student_id = $1", "user_id = $2"];
    const values = [student.id, req.user.id];
    const sortMap = {
      name: `item_type ASC, name ${dir}`,
      date: `updated_at ${dir}`,
      size: `item_type ASC, size_bytes ${dir}, name ASC`,
    };
    let orderBy = sortMap[sort] || sortMap.name;
    if (view === "trash") {
      clauses.push("is_trashed = true");
      orderBy = sortMap[sort] || "updated_at DESC";
    } else {
      clauses.push("is_trashed = false");
      if (view === "starred") {
        clauses.push("is_starred = true");
        orderBy = sortMap[sort] || "updated_at DESC";
      } else if (view === "recent") {
        orderBy = "last_opened_at DESC NULLS LAST, updated_at DESC";
      } else if (view === "home") {
        orderBy = sortMap[sort] || "updated_at DESC";
      } else if (folderId) {
        clauses.push(`parent_id = $${values.length + 1}`);
        values.push(folderId);
      } else {
        clauses.push("parent_id IS NULL");
      }
    }
    if (search) {
      clauses.push(`name ILIKE $${values.length + 1}`);
      values.push(`%${search}%`);
    }
    const rows = (
      await query(
        `SELECT * FROM library_items
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${orderBy}
         LIMIT 200`,
        values
      )
    ).rows;
    res.json({ items: rows.map(toLibraryItem), account: await buildAccountSnapshot(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/folders", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { name = "新建文件夹", parentId = null } = req.body || {};
    const row = (
      await query(
        `INSERT INTO library_items (student_id, user_id, parent_id, item_type, name)
         VALUES ($1, $2, $3, 'folder', $4)
         RETURNING *`,
        [student.id, req.user.id, parentId || null, name.trim() || "新建文件夹"]
      )
    ).rows[0];
    res.json({ item: toLibraryItem(row) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/documents", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { name = "新建文档", parentId = null, content = "" } = req.body || {};
    const row = (
      await query(
        `INSERT INTO library_items (student_id, user_id, parent_id, item_type, name, content, mime_type)
         VALUES ($1, $2, $3, 'document', $4, $5, 'text/plain')
         RETURNING *`,
        [student.id, req.user.id, parentId || null, name.trim() || "新建文档", content || ""]
      )
    ).rows[0];
    res.json({ item: toLibraryItem(row) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/files", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "FILES_REQUIRED" });
    const student = await getPrimaryStudent(req.user);
    const { parentId = null } = req.body || {};
    const items = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "library", files);
      const rows = [];
      for (let index = 0; index < fileRows.length; index += 1) {
        const fileRow = fileRows[index];
        const sourceFile = files[index];
        const extractedText = await extractDocumentText(sourceFile);
        const row = (
          await client.query(
            `INSERT INTO library_items (student_id, user_id, parent_id, item_type, name, file_id, content, mime_type, size_bytes)
             VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              student.id,
              req.user.id,
              parentId || null,
              fileRow.original_name,
              fileRow.id,
              extractedText,
              fileRow.mime_type,
              Number(fileRow.size_bytes || 0),
            ]
          )
        ).rows[0];
        rows.push(row);
      }
      return rows;
    });
    res.json({ items: items.map(toLibraryItem), account: await buildAccountSnapshot(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/library/items/:id", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const existing = (await query("SELECT * FROM library_items WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: "ITEM_NOT_FOUND" });
    const patch = req.body || {};
    const row = (
      await query(
        `UPDATE library_items
         SET name = $3,
             content = $4,
             notes = $5,
             is_starred = $6,
             is_trashed = $7,
             parent_id = $8,
             last_opened_at = CASE WHEN $9 THEN now() ELSE last_opened_at END,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          req.params.id,
          req.user.id,
          patch.name ?? existing.name,
          patch.content ?? existing.content,
          patch.notes ?? existing.notes,
          patch.isStarred ?? existing.is_starred,
          patch.isTrashed ?? existing.is_trashed,
          patch.parentId === undefined ? existing.parent_id : patch.parentId || null,
          Boolean(patch.opened),
        ]
      )
    ).rows[0];
    res.json({ item: toLibraryItem(row) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/transcribe", requireAuth, upload.single("audio"), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 6);
    if (!req.file) return res.status(400).json({ error: "AUDIO_REQUIRED", message: "请上传音频文件。" });
    const student = await getPrimaryStudent(req.user);
    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: transcriptionModel,
    });
    const text = transcript.text || "";
    const saved = await withTransaction(async (client) => {
      const files = await saveUploadedFiles(client, req.user, student, "statement_audio", [req.file]);
      const row = (
        await client.query(
          `INSERT INTO statement_audio_files (student_id, user_id, file_id, transcript)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [student.id, req.user.id, files[0]?.id || null, text]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'audio_transcript', '语音陈述转写', $3)`,
        [student.id, req.user.id, JSON.stringify({ transcript: text })]
      );
      return row;
    });
    await recordTokenUsage(req.user.id, 6, "语音转文字", { feature: "transcribe", audioId: saved.id });
    res.json({ transcript: text, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/study-plan", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 8);
    const student = await getPrimaryStudent(req.user);
    const { archiveSnapshot = {}, currentPlanRows = [], methodFocusRows = [], habitFocusRows = [] } = req.body || {};
    const response = await openai.responses.create({
      model: textModel,
      input: [
        {
          role: "system",
          content:
            "你是树子AI学习计划制定智能体。只根据已确认的学情画像、科目策略、学习任务、空闲时间和方法习惯目标，生成可以由学生继续修改的周学习计划。不要重新诊断学情，不要分析图片，不要生成相似题。输出必须具体、可执行、时间不过量。",
        },
        {
          role: "user",
          content: `${jsonInstruction(
            "{note, rows:[{cells:{星期一:{start,end,task,note},星期二:{start,end,task,note},星期三:{start,end,task,note},星期四:{start,end,task,note},星期五:{start,end,task,note},星期六:{start,end,task,note},星期日:{start,end,task,note}}}], method_focus_suggestions, habit_focus_suggestions, execution_notes}"
          )}\n学生档案摘要：${JSON.stringify(archiveSnapshot)}\n当前计划表：${JSON.stringify(currentPlanRows)}\n方法训练目标：${JSON.stringify(methodFocusRows)}\n习惯培养目标：${JSON.stringify(habitFocusRows)}`,
        },
      ],
    });
    const plan = parseJsonText(getResponseText(response), { rows: [], note: "" });
    await query(
      `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
       VALUES ($1, $2, 'study_plan_ai', 'AI辅助制定学习计划', $3)`,
      [student.id, req.user.id, JSON.stringify({ plan })]
    );
    await recordTokenUsage(req.user.id, 8, "AI辅助制定学习计划", { feature: "study-plan" });
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/mistakes/workflow", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureGeminiKey();
    const files = req.files || [];
    const student = await getPrimaryStudent(req.user);
    const {
      taskType = "analyzeMistake",
      prompt = "",
      subject = "",
      title = "错题专项处理",
      source = "",
      archiveSnapshot = "{}",
    } = req.body || {};
    const tokenCost = taskType === "generateSimilar" ? 10 : 12;
    await assertTokenBalance(req.user.id, tokenCost);
    if (!prompt.trim() && !files.length) return res.status(400).json({ error: "PROMPT_OR_FILE_REQUIRED" });

    const taskMap = {
      analyzeMistake: "AI分析错题：识别题目内容、知识点、错误类型、错因、解题方法缺口和后续训练建议。",
      generateSimilar: "AI生成类似题：根据上传或选择的错题生成1-3道同类型训练题，包含答案、步骤和训练目的。",
      analyzePaper: "AI分析试卷：整理试卷/作业中的错题清单、薄弱知识点、错误类型、优先训练顺序和复习建议。",
    };
    const documentText = await makeDocumentTextSummary(files);
    const geminiMode = taskType === "analyzePaper" ? "thinking" : "fast";
    const geminiModel = getGeminiModel(geminiMode);
    const geminiPrompt = [
      "你是树子AI错题专项智能体。你的任务只围绕错题、同类题训练、作业/试卷材料分析和错题档案沉淀。",
      "输出要像给学生看的学习报告，干净、完整、具体、可执行。不要生成学情画像总报告，不要制定完整周计划。必须输出严格JSON。",
      jsonInstruction(
        "{title, summary, sections:[{title,content}], extracted_questions:[{id,title,question_content,subject,error_type,knowledge_points,method_gap,correction_steps,suggestion,is_likely_wrong}], similar_questions:[{title,question,answer,solution_steps,training_goal,difficulty}], training_suggestions:[string], archive_note}"
      ),
      `任务类型：${taskMap[taskType] || taskMap.analyzeMistake}`,
      `科目：${subject}`,
      `标题：${title}`,
      `来源：${source}`,
      `学生提示词：${prompt}`,
      `学生档案摘要：${archiveSnapshot}`,
      `上传文档文字摘录：\n${documentText || "无可提取文档文字；如有图片或PDF，请结合附件内容分析。"}`,
    ].join("\n");
    const reportText = await generateGeminiText({ model: geminiModel, prompt: geminiPrompt, files });
    const report = parseJsonText(reportText, {
      title,
      summary: "",
      sections: [],
      extracted_questions: [],
      similar_questions: [],
      training_suggestions: [],
    });
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "mistake", files);
      const row = (
        await client.query(
          `INSERT INTO mistake_files (student_id, user_id, subject, title, file_ids, analysis)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, subject, title, fileRows.map((item) => item.id), JSON.stringify({ taskType, prompt, provider: "gemini", model: geminiModel, report })]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'mistake_workspace', $3, $4)`,
        [student.id, req.user.id, title, JSON.stringify({ taskType, prompt, provider: "gemini", model: geminiModel, report, fileCount: files.length })]
      );
      return row;
    });
    await recordTokenUsage(req.user.id, tokenCost, taskMap[taskType] || "错题专项AI处理", {
      feature: "mistake-workflow",
      provider: "gemini",
      model: geminiModel,
      mode: geminiMode,
      taskType,
      mistakeId: saved.id,
    });
    res.json({ report, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/mistakes/analyze", requireAuth, upload.array("files", 6), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureGeminiKey();
    await assertTokenBalance(req.user.id, 12);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "FILES_REQUIRED" });
    const student = await getPrimaryStudent(req.user);
    const { subject = "", title = "错题分析", note = "" } = req.body || {};
    const prompt = [
      "你是树子AI错题专项智能体。只围绕上传材料中的错题识别、题目拆分、错因归类、知识点、解题方法缺口、相似题训练建议和复测安排输出。",
      "如果材料里有多道题，要拆成题目清单；不要制定完整周计划，不要做学情画像总报告。必须输出严格JSON。",
      jsonInstruction(
        "{summary, extracted_questions:[{id,title,question_content,subject,error_type,knowledge_points,method_gap,correction_steps,suggestion,is_likely_wrong}], analysis:{test_point,error_reason,method_gap,correction_steps,training_suggestions,review_schedule}}"
      ),
      `科目：${subject}`,
      `标题：${title}`,
      `学生补充：${note}`,
    ].join("\n");
    const analysisText = await generateGeminiText({ model: geminiFastModel, prompt, files });
    const analysis = parseJsonText(analysisText, { mistake_title: title });
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "mistake", files);
      const row = (
        await client.query(
          `INSERT INTO mistake_files (student_id, user_id, subject, title, file_ids, analysis)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, subject, title, fileRows.map((item) => item.id), JSON.stringify({ provider: "gemini", model: geminiFastModel, analysis })]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'mistake_analysis', $3, $4)`,
        [student.id, req.user.id, title, JSON.stringify({ provider: "gemini", model: geminiFastModel, analysis })]
      );
      return row;
    });
    await recordTokenUsage(req.user.id, 12, "AI错题识别", { feature: "mistake-analyze", provider: "gemini", model: geminiFastModel, mistakeId: saved.id });
    res.json({ analysis, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/mistakes/practice", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureGeminiKey();
    await assertTokenBalance(req.user.id, 10);
    const student = await getPrimaryStudent(req.user);
    const { sourceMistakeId = null, subject = "", mistake = {}, count = 3 } = req.body || {};
    const prompt = [
      "你是树子AI相似题训练智能体。根据错题的知识点、方法缺口和错误类型，生成1-3道相似题，必须包含答案、步骤和训练目的。必须输出严格JSON。",
      jsonInstruction("{questions:[{title, question, answer, solution_steps, training_goal, difficulty}]}"),
      `科目：${subject}`,
      `数量：${Math.min(3, Math.max(1, Number(count) || 1))}`,
      `错题信息：${JSON.stringify(mistake)}`,
    ].join("\n");
    const generatedText = await generateGeminiText({ model: geminiFastModel, prompt });
    const generated = parseJsonText(generatedText, { questions: [] });
    const saved = (
      await query(
        `INSERT INTO generated_practice (student_id, user_id, source_mistake_id, questions)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [student.id, req.user.id, sourceMistakeId, JSON.stringify(generated.questions || generated)]
      )
    ).rows[0];
    await recordTokenUsage(req.user.id, 10, "AI生成相似题", { feature: "mistake-practice", provider: "gemini", model: geminiFastModel, practiceId: saved.id });
    res.json({ practice: generated, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/knowledge-note", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 35);
    const student = await getPrimaryStudent(req.user);
    const { topic = "", grade = "", subject = "", useTemplate = false, template = "" } = req.body || {};
    if (!topic.trim()) return res.status(400).json({ error: "TOPIC_REQUIRED" });
    const templateSource = String(template || "").trim() || knowledgeInfographicTemplate;
    const templatePrompt =
      useTemplate === true || useTemplate === "true"
        ? `\n\n专业知识图模板：\n${templateSource.replaceAll("[SUBJECT]", topic.trim())}`
        : "";
    const prompt =
      `请为学生制作一张严谨、丰富、适合复习的中文知识图。主题：${topic}。学科：${subject || "不限"}。年级：${grade || "中学生"}。` +
      "画面要求：信息量充足，包含标题、结构图、标注线、关键概念解释、底部总结，不要做简单示意图，风格专业清晰。" +
      templatePrompt;
    const response = await openai.responses.create({
      model: imageModel,
      input: prompt,
      tools: [{ type: "image_generation" }],
    });
    const imageBase64 = getGeneratedImageBase64(response);
    const note = {
      topic,
      prompt,
      text: getResponseText(response),
      imageMimeType: "image/png",
    };
    const saved = (
      await query(
        `INSERT INTO knowledge_notes (student_id, user_id, topic, note, image_base64)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, student_id, user_id, topic, note, created_at`,
        [student.id, req.user.id, topic, JSON.stringify(note), imageBase64 || null]
      )
    ).rows[0];
    await recordTokenUsage(req.user.id, 35, "AI知识图生成", { feature: "knowledge-note", noteId: saved.id });
    res.json({ note, imageBase64, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/free-ask", requireAuth, upload.array("files", 6), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { question = "", wantsImage = "false", provider = "openai", mode = "fast" } = req.body || {};
    const tokenCost = wantsImage === "true" ? 12 : mode === "thinking" ? 8 : 5;
    await assertTokenBalance(req.user.id, tokenCost);
    const files = req.files || [];
    const aiProvider = normalizeAiProvider(provider);
    const aiMode = normalizeAiMode(mode);
    if (!String(question).trim() && !files.length) {
      return res.status(400).json({ error: "QUESTION_REQUIRED", message: "请输入问题，或上传图片/文件。" });
    }
    const fileSummary = files.length
      ? files.map((file) => `${file.originalname}（${file.mimetype || "未知类型"}）`).join("、")
      : "无附件";
    const documentText = await makeDocumentTextSummary(files);
    const promptText = [
      `学生问题：${question || "请结合附件回答。"}`,
      `是否希望生成知识图方向：${wantsImage === "true" ? "是" : "否"}`,
      `附件：${fileSummary}`,
      documentText ? `附件文字摘录：\n${documentText}` : "",
    ].filter(Boolean).join("\n");

    let answer = "";
    let model = "";
    if (aiProvider === "gemini") {
      model = getGeminiModel(aiMode);
      answer = await generateGeminiText({
        model,
        prompt: [
          "你是树子AI自由问助手。可以回答学习问题、知识问题、作业问题，也可以回答学生对科学、生活、兴趣和开放想法的提问。回答要清晰、友好、适合中学生理解；如果问题涉及学习，要给出可执行的下一步。",
          promptText,
        ].join("\n"),
        files,
        temperature: aiMode === "thinking" ? 0.2 : 0.35,
      });
    } else {
      ensureOpenAIKey();
      model = getOpenAITextModel(aiMode);
      const imageInputs = makeImageInputs(files);
      const response = await openai.responses.create({
        model,
        input: [
          {
            role: "system",
            content:
              "你是树子AI自由问助手。可以回答学习问题、知识问题、作业问题，也可以回答学生对科学、生活、兴趣和开放想法的提问。回答要清晰、友好、适合中学生理解；如果问题涉及学习，要给出可执行的下一步；如果用户要求做知识图，先用文字说明结构和重点。",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: promptText,
              },
              ...imageInputs,
            ],
          },
        ],
      });
      answer = getResponseText(response);
    }

    answer = answer || "AI已阅读你的问题，但暂时没有生成有效回答，请换一种问法再试。";
    if (files.length) {
      await withTransaction(async (client) => {
        const fileRows = await saveUploadedFiles(client, req.user, student, "free_ask", files);
        await client.query(
          `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
           VALUES ($1, $2, 'free_ask', $3, $4)`,
          [student.id, req.user.id, "AI自由问", JSON.stringify({ question, answer, provider: aiProvider, mode: aiMode, model, fileIds: fileRows.map((item) => item.id) })]
        );
      });
    } else {
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'free_ask', $3, $4)`,
        [student.id, req.user.id, "AI自由问", JSON.stringify({ question, answer, provider: aiProvider, mode: aiMode, model })]
      );
    }
    await recordTokenUsage(req.user.id, tokenCost, "AI自由问", {
      feature: "free-ask",
      provider: aiProvider,
      mode: aiMode,
      model,
    });
    res.json({ answer, provider: aiProvider, mode: aiMode, model });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/memberships/activate", requireAdminToken, async (req, res) => {
  const { identifier, planId = "monthly", durationDays, paidAmountCny = 0, startDate } = req.body || {};
  const plan = membershipPlans[planId];
  if (!plan || plan.id === "free") return res.status(400).json({ error: "INVALID_PLAN" });
  const user = (await query("SELECT * FROM users WHERE identifier = $1", [normalizeIdentifier(identifier)])).rows[0];
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const { startedAt, expiresAt, days } = getMembershipWindow(startDate, durationDays || plan.durationDays || 31);
  const membership = (
    await query(
      `INSERT INTO student_memberships (user_id, plan_id, plan_name, status, started_at, expires_at)
       VALUES ($1, $2, $3, 'active', $4, $5)
       RETURNING *`,
      [user.id, plan.id, plan.name, startedAt, expiresAt]
    )
  ).rows[0];
  await query(
    `INSERT INTO storage_quotas (user_id, base_mb, expansion_mb, used_bytes)
     VALUES ($1, $2, 0, 0)
     ON CONFLICT (user_id) DO UPDATE SET base_mb = EXCLUDED.base_mb, updated_at = now()`,
    [user.id, plan.storageMb]
  );
  if (Number(paidAmountCny) > 0) {
    await query(
      `INSERT INTO payment_orders (user_id, order_type, package_id, title, amount_cny, status, provider, meta, paid_at)
       VALUES ($1, 'membership', $2, $3, $4, 'paid', 'manual_admin', $5, now())`,
      [user.id, plan.id, plan.name, Number(paidAmountCny), JSON.stringify({ adminConfirmed: true, startedAt, expiresAt, durationDays: days })]
    );
  }
  res.json({ membership, account: await buildAccountSnapshot(user.id) });
});

app.post("/api/admin/lt/recharge", requireAdminToken, async (req, res) => {
  const { identifier, packageId, amount, paidAmountCny = 0, note = "" } = req.body || {};
  const user = (await query("SELECT * FROM users WHERE identifier = $1", [normalizeIdentifier(identifier)])).rows[0];
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const pack = packageId ? ltPackages[packageId] : null;
  const tokens = Number(amount || pack?.learningTokens || 0);
  if (!tokens) return res.status(400).json({ error: "INVALID_AMOUNT" });
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO learning_token_wallets (user_id, balance, reserved)
       VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );
    await client.query("UPDATE learning_token_wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1", [
      user.id,
      tokens,
    ]);
    await client.query(
      `INSERT INTO learning_token_transactions (user_id, amount, type, source, note, meta)
       VALUES ($1, $2, 'recharge', 'manual_admin', $3, $4)`,
      [user.id, tokens, note, JSON.stringify({ packageId: pack?.id || null, paidAmountCny: Number(paidAmountCny) || null })]
    );
    if (Number(paidAmountCny) > 0) {
      await client.query(
        `INSERT INTO payment_orders (user_id, order_type, package_id, title, amount_cny, status, provider, meta, paid_at)
         VALUES ($1, 'lt_recharge', $2, $3, $4, 'paid', 'manual_admin', $5, now())`,
        [user.id, pack?.id || "custom-token", `Token充值 ${tokens}`, Number(paidAmountCny), JSON.stringify({ tokens, note })]
      );
    }
  });
  res.json({ account: await buildAccountSnapshot(user.id) });
});

app.get("/api/admin/orders", requireAdminToken, async (req, res) => {
  const orders = (
    await query(
      `SELECT
        po.id,
        po.user_id,
        po.order_type,
        po.package_id,
        po.title,
        po.amount_cny,
        po.status,
        po.provider,
        po.meta,
        po.created_at,
        po.paid_at,
        po.updated_at,
        u.identifier,
        u.display_name,
        s.name AS student_name
       FROM payment_orders po
       JOIN users u ON u.id = po.user_id
       LEFT JOIN students s ON s.user_id = po.user_id
       ORDER BY
         CASE po.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
         po.created_at DESC
       LIMIT 100`
    )
  ).rows;
  res.json({ orders });
});

app.post("/api/admin/orders/:id/confirm", requireAdminToken, async (req, res) => {
  const { note = "", startDate = "" } = req.body || {};
  const { id } = req.params;
  const result = await withTransaction(async (client) => {
    const order = (await client.query("SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!order) throw createHttpError(404, "ORDER_NOT_FOUND", "没有找到这条付款申请。");
    if (order.status !== "pending") throw createHttpError(400, "ORDER_ALREADY_PROCESSED", "这条付款申请已经处理过。");

    const meta = parsePaymentMeta(order.meta);
    const user = (await client.query("SELECT * FROM users WHERE id = $1", [order.user_id])).rows[0];
    if (!user) throw createHttpError(404, "USER_NOT_FOUND", "没有找到对应用户。");

    if (order.order_type === "membership") {
      const plan = membershipPlans[order.package_id];
      if (!plan || plan.id === "free") throw createHttpError(400, "INVALID_PLAN", "会员套餐不存在。");
      const { startedAt, expiresAt, days } = getMembershipWindow(startDate || meta.startedAt, meta.durationDays || plan.durationDays || 31);
      await client.query(
        `INSERT INTO student_memberships (user_id, plan_id, plan_name, status, started_at, expires_at)
         VALUES ($1, $2, $3, 'active', $4, $5)`,
        [order.user_id, plan.id, plan.name, startedAt, expiresAt]
      );
      await client.query(
        `INSERT INTO storage_quotas (user_id, base_mb, expansion_mb, used_bytes)
         VALUES ($1, $2, 0, 0)
         ON CONFLICT (user_id) DO UPDATE SET base_mb = EXCLUDED.base_mb, updated_at = now()`,
        [order.user_id, plan.storageMb]
      );
      await client.query(
        `UPDATE payment_orders
         SET status = 'paid', provider = 'manual_admin', paid_at = now(), updated_at = now(), meta = $2
         WHERE id = $1`,
        [
          id,
          mergeMeta(meta, {
            adminConfirmed: true,
            adminNote: note,
            startedAt,
            expiresAt,
            durationDays: days,
          }),
        ]
      );
    } else if (order.order_type === "lt_recharge") {
      const pack = ltPackages[order.package_id];
      const tokens = Math.max(1, Math.round(Number(meta.learningTokens || pack?.learningTokens || 0)));
      if (!tokens) throw createHttpError(400, "INVALID_TOKEN_ORDER", "Token充值数量无效。");
      await client.query(
        `INSERT INTO learning_token_wallets (user_id, balance, reserved)
         VALUES ($1, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [order.user_id]
      );
      await client.query("UPDATE learning_token_wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1", [order.user_id, tokens]);
      await client.query(
        `INSERT INTO learning_token_transactions (user_id, amount, type, source, note, meta)
         VALUES ($1, $2, 'recharge', 'manual_admin', $3, $4)`,
        [
          order.user_id,
          tokens,
          note || "管理员确认Token充值",
          JSON.stringify({ orderId: id, packageId: order.package_id, paidAmountCny: Number(order.amount_cny) }),
        ]
      );
      await client.query(
        `UPDATE payment_orders
         SET status = 'paid', provider = 'manual_admin', paid_at = now(), updated_at = now(), meta = $2
         WHERE id = $1`,
        [id, mergeMeta(meta, { adminConfirmed: true, adminNote: note, learningTokens: tokens })]
      );
    } else {
      throw createHttpError(400, "UNSUPPORTED_ORDER_TYPE", "暂不支持这种付款申请。");
    }

    const updatedOrder = (await client.query("SELECT * FROM payment_orders WHERE id = $1", [id])).rows[0];
    return { order: updatedOrder, user };
  });
  res.json({ order: result.order, account: await buildAccountSnapshot(result.user.id) });
});

app.post("/api/admin/orders/:id/cancel", requireAdminToken, async (req, res) => {
  const { note = "" } = req.body || {};
  const order = (
    await query(
      `UPDATE payment_orders
       SET status = 'cancelled', provider = 'manual_admin', updated_at = now(), meta = meta || $2::jsonb
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [req.params.id, JSON.stringify({ adminCancelled: true, adminNote: note, cancelledAt: new Date().toISOString() })]
    )
  ).rows[0];
  if (!order) throw createHttpError(404, "ORDER_NOT_FOUND", "没有找到待处理的付款申请。");
  res.json({ order });
});

app.get("/api/admin/users", requireAdminToken, async (req, res) => {
  await expireOutdatedMemberships();
  const users = (
    await query(
      `SELECT
        u.id,
        u.identifier,
        u.display_name,
        u.created_at,
        s.name AS student_name,
        m.plan_name,
        m.status AS membership_status,
        m.expires_at,
        w.balance,
        q.base_mb,
        q.expansion_mb,
        q.used_bytes
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT * FROM student_memberships sm
        WHERE sm.user_id = u.id
        ORDER BY sm.created_at DESC
        LIMIT 1
      ) m ON true
      LEFT JOIN learning_token_wallets w ON w.user_id = u.id
      LEFT JOIN storage_quotas q ON q.user_id = u.id
      ORDER BY u.created_at DESC
      LIMIT 100`
    )
  ).rows;
  res.json({ users, plans: Object.values(membershipPlans), tokenPackages: Object.values(ltPackages) });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.code || "SERVER_ERROR",
    message: error.status ? error.message : "服务器处理失败。",
    detail: error.message,
  });
});

ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Shuzi AI API listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database schema", error);
    process.exit(1);
  });
