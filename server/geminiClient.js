import fs from "node:fs";

const geminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/models";

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

export async function generateGeminiText({ model, prompt, files = [], temperature = 0.25 }) {
  ensureGeminiKey();
  const parts = [{ text: prompt }, ...files.map(toGeminiPart).filter(Boolean)];
  const response = await fetch(`${geminiEndpoint}/${encodeURIComponent(model)}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Gemini request failed.");
    error.status = response.status;
    error.code = data?.error?.status || "GEMINI_REQUEST_FAILED";
    error.detail = data;
    throw error;
  }
  return getGeminiText(data);
}
