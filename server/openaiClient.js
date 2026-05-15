import fs from "node:fs";
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export function ensureOpenAIKey() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 503;
    error.code = "OPENAI_NOT_CONFIGURED";
    throw error;
  }
}

export function readFileAsDataUrl(file) {
  const bytes = fs.readFileSync(file.path);
  const mimeType = file.mimetype || "application/octet-stream";
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

export function parseJsonText(text, fallback = {}) {
  if (!text) return fallback;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        return { ...fallback, rawText: text };
      }
    }
    return { ...fallback, rawText: text };
  }
}

export function getResponseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n");
}

export function getGeneratedImageBase64(response) {
  return (response.output || [])
    .filter((output) => output.type === "image_generation_call")
    .map((output) => output.result)
    .find(Boolean);
}
