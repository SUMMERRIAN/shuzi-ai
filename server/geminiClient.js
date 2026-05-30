import fs from "node:fs";

const geminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/models";
const geminiTimeoutMs = Math.max(15000, Number(process.env.GEMINI_TIMEOUT_MS || 120000));
const geminiMaxOutputTokens = Math.max(1024, Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 16384));
const defaultGeminiThinkingBudget =
  process.env.GEMINI_THINKING_BUDGET === undefined ? 1024 : Number(process.env.GEMINI_THINKING_BUDGET);

export function ensureGeminiKey() {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is not configured.");
    error.status = 503;
    error.code = "GEMINI_NOT_CONFIGURED";
    throw error;
  }
}

function toGeminiPart(file) {
  const mimeType = file.mimetype || "application/octet-stream";
  const supported =
    mimeType.startsWith("image/") ||
    mimeType === "application/pdf" ||
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    mimeType === "text/csv";
  if (!supported) return null;
  const data = fs.readFileSync(file.path).toString("base64");
  return {
    inline_data: {
      mime_type: mimeType,
      data,
    },
  };
}

export function getGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeThinkingBudget(value) {
  const budget = Number(value);
  return Number.isFinite(budget) ? Math.trunc(budget) : undefined;
}

export async function generateGeminiText({
  model,
  prompt,
  files = [],
  temperature = 0.25,
  responseMimeType = "",
  thinkingBudget = defaultGeminiThinkingBudget,
}) {
  ensureGeminiKey();
  const parts = [{ text: prompt }, ...files.map(toGeminiPart).filter(Boolean)];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), geminiTimeoutMs);
  const normalizedThinkingBudget = normalizeThinkingBudget(thinkingBudget);
  let response;
  try {
    response = await fetch(`${geminiEndpoint}/${encodeURIComponent(model)}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          candidateCount: 1,
          maxOutputTokens: geminiMaxOutputTokens,
          ...(normalizedThinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget: normalizedThinkingBudget } }
            : {}),
          ...(responseMimeType ? { responseMimeType } : {}),
        },
      }),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Gemini请求超过${Math.round(geminiTimeoutMs / 1000)}秒仍未返回，请稍后重试或减少上传材料。`);
      timeoutError.status = 504;
      timeoutError.code = "GEMINI_TIMEOUT";
      timeoutError.provider = "gemini";
      timeoutError.model = model;
      timeoutError.detail = `GEMINI_TIMEOUT_MS=${geminiTimeoutMs}`;
      throw timeoutError;
    }
    error.provider = "gemini";
    error.model = model;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const rawText = await response.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { rawText };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Gemini request failed.");
    error.status = response.status;
    error.code = data?.error?.status || "GEMINI_REQUEST_FAILED";
    error.detail = data?.error || data;
    error.provider = "gemini";
    error.model = model;
    throw error;
  }
  const text = getGeminiText(data);
  if (!text) {
    const error = new Error("Gemini没有返回有效文本，请稍后重试或检查模型权限。");
    error.status = 502;
    error.code = "GEMINI_EMPTY_RESPONSE";
    error.detail = data;
    error.provider = "gemini";
    error.model = model;
    throw error;
  }
  return text;
}
