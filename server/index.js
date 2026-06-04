import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
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

const textModel = process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL_THINKING || "gpt-5.4-mini";
const openaiFastModel = process.env.OPENAI_MODEL_FAST || process.env.OPENAI_MODEL_TEXT || textModel;
const openaiThinkingModel = process.env.OPENAI_MODEL_THINKING || process.env.OPENAI_MODEL_TEXT || "gpt-5.4";
const geminiFastModel = process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash";
const geminiThinkingModel = process.env.GEMINI_MODEL_THINKING || "gemini-3.5-flash";
const imageModel = process.env.OPENAI_MODEL_IMAGE || "gpt-image-2";
const imageGenerationEnabled = process.env.OPENAI_IMAGE_GENERATION_ENABLED === "true";
const imageQuality = process.env.OPENAI_IMAGE_QUALITY || "medium";
const imageSize = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const imageBackgroundPollMs = Number(process.env.OPENAI_IMAGE_BACKGROUND_POLL_MS || 5000);
const imageBackgroundMaxPolls = Number(process.env.OPENAI_IMAGE_BACKGROUND_MAX_POLLS || 120);
const transcriptionModel = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe";

const knowledgeInfographicTemplate = `超精细教育信息图 [SUBJECT]，
科学教科书插画风格，干净的学习笔记版式。
包含标题、核心结构图、3到5个关键标注、底部一句总结。
白色背景，文字尽量少但清楚，适合中学生复习。`;

const defaultStudyPlanTimePolicy = [
  "如果学生没有明确填写可用时间，默认按中国大陆中学生的常见学习日节奏来安排。",
  "早晨起床后到7:00前，通常可安排15到20分钟轻任务，例如背诵、预习、回忆错题方法。",
  "白天在学校上课期间，不默认安排完整自主学习任务；课间10分钟最多安排10分钟以内的轻量任务，例如看一眼错题卡、背2到3个关键词、快速回忆一个方法。",
  "晚自习一般可安排一节课左右的自主学习任务，适合错题复盘、专题训练、限时练习或阶段复习。",
  "回家后默认还有约90分钟可用学习时间，适合作业收尾、错题复盘、专题训练、整理明日任务或轻量背诵。",
  "默认睡觉时间约为22:30到23:00，不能把任务堆到太晚，计划必须留出休息余量。",
  "周末可以比平日安排稍长一点，但仍要避免满负荷堆任务。",
  "必须在计划说明 note 中提醒：以上时间只是默认建议，学生可以根据自己的真实作息自行修改。"
].join("\n");

function normalizeAiProvider(provider = "") {
  return String(provider).toLowerCase() === "gemini" ? "gemini" : "openai";
}

function normalizeAiMode(mode = "") {
  return String(mode).toLowerCase() === "thinking" ? "thinking" : "fast";
}

function getOpenAITextModel(mode = "fast") {
  return normalizeAiMode(mode) === "thinking" ? openaiThinkingModel : openaiFastModel;
}

async function generateOpenAIImageBackground(prompt, onResponseId = async () => {}, quality = imageQuality) {
  if (!imageGenerationEnabled) {
    throw createHttpError(503, "OPENAI_IMAGE_GENERATION_DISABLED", "AI生图已暂时关闭，避免继续消耗OpenAI费用。");
  }
  try {
    let response = await openai.responses.create({
      model: openaiFastModel,
      input: prompt,
      tools: [{ type: "image_generation", quality, size: imageSize }],
      background: true,
    });
    await onResponseId(response.id);
    response = await waitForOpenAIBackgroundResponse(response, {
      timeoutMessage: "OpenAI后台生图仍未完成，系统已尝试取消以控制费用。",
      pollMs: imageBackgroundPollMs,
      maxPolls: imageBackgroundMaxPolls,
    });
    const imageBase64 = getGeneratedImageBase64(response);
    if (!imageBase64) {
      throw createHttpError(502, "OPENAI_IMAGE_EMPTY_RESPONSE", "OpenAI没有返回有效图片，请稍后重试或检查图片模型权限。");
    }
    return imageBase64;
  } catch (error) {
    error.provider = "openai";
    error.model = imageModel;
    throw error;
  }
}

function resolveImageQuality(text = "") {
  const content = String(text || "").toLowerCase();
  if (/低质量|省钱|节省|快速|快一点|便宜|测试|草稿|low|draft|cheap|fast/.test(content)) return "low";
  if (/高清|高质量|精细|细致|更清楚|高分辨率|正式版|high|hd|detailed|premium/.test(content)) return "high";
  if (/中等|中等质量|默认|普通质量|medium|normal|standard/.test(content)) return "medium";
  return imageQuality;
}

function fallbackKnowledgeBreakdown(topic = "") {
  const cleanTopic = String(topic || "知识点").trim();
  return {
    title: cleanTopic,
    subtitle: "AI生成知识图",
    summary: `围绕“${cleanTopic}”整理核心内容，帮助学生先理解结构，再记住重点。`,
    points: [
      { name: "核心概念", desc: `先弄清楚“${cleanTopic}”是什么、解决什么问题。`, tip: "不要只背名词，要能用自己的话解释。" },
      { name: "组成结构", desc: "把知识点拆成几个可以观察、比较或推理的部分。", tip: "看图时先找整体，再看局部。" },
      { name: "关键关系", desc: "理解原因、条件、过程和结果之间的联系。", tip: "复习时画箭头，比单纯抄写更有效。" },
      { name: "典型应用", desc: "知道它在题目、实验或生活情境中怎样使用。", tip: "遇到题目先判断它考的是哪个关系。" },
      { name: "易错提醒", desc: "区分相似概念，避免把名称、功能或条件混在一起。", tip: "错题里要写清楚自己错在哪里。" },
    ],
    imageBrief: "用中心结构图配合周围短标签呈现，适合学生复习。",
  };
}

async function generateKnowledgeBreakdown({ topic, grade = "", subject = "", promptText = "", onUsage = null }) {
  const response = await openai.responses.create({
    model: openaiFastModel,
    input: [
      {
        role: "system",
        content:
          "你是树子AI知识笔记老师。任务是把学生输入的知识点整理成适合中学生复习的中文知识拆解。必须严格输出JSON，不要输出Markdown。解释要准确、短、学生能懂。",
      },
      {
        role: "user",
        content:
          jsonInstruction(
            "{title:string, subtitle:string, summary:string, points:[{name:string, desc:string, tip:string}], image_brief:string}"
          ) +
          "\n主题：" + topic +
          "\n学科：" + (subject || "不限") +
          "\n年级：" + (grade || "中学生") +
          "\n学生要求：" + promptText +
          "\n要求：points 生成5到7个核心知识点；desc用一句话解释功能或含义；tip写一个学习提醒或易错点；image_brief用一句话说明图片应如何呈现。",
      },
    ],
  });
  if (typeof onUsage === "function") {
    await onUsage(createOpenAIUsageEvent(response, openaiFastModel));
  }
  const parsed = parseJsonText(getResponseText(response), {});
  const points = Array.isArray(parsed.points)
    ? parsed.points
        .map((item) => ({
          name: String(item?.name || "").trim(),
          desc: String(item?.desc || "").trim(),
          tip: String(item?.tip || "").trim(),
        }))
        .filter((item) => item.name && item.desc)
        .slice(0, 7)
    : [];
  const fallback = fallbackKnowledgeBreakdown(topic);
  return {
    title: String(parsed.title || topic || "知识图").trim(),
    subtitle: String(parsed.subtitle || fallback.subtitle).trim(),
    summary: String(parsed.summary || fallback.summary).trim(),
    points: points.length ? points : fallback.points,
    imageBrief: String(parsed.image_brief || fallback.imageBrief).trim(),
  };
}

function getGeminiModel(mode = "fast") {
  return normalizeAiMode(mode) === "thinking" ? geminiThinkingModel : geminiFastModel;
}

function getMistakeGeminiModel(qualityMode = "high") {
  return String(qualityMode).toLowerCase() !== "fast"
    ? process.env.GEMINI_MODEL_MISTAKE_HIGH || geminiThinkingModel
    : process.env.GEMINI_MODEL_MISTAKE || geminiFastModel;
}

const geminiModelCooldowns = new Map();

function getGeminiModelCooldownMs() {
  return Math.max(60000, Number(process.env.GEMINI_MODEL_COOLDOWN_MS || 10 * 60 * 1000));
}

function getGeminiMistakeRetryDelaysMs() {
  const configured = String(process.env.GEMINI_MISTAKE_RETRY_DELAYS_MS || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return configured.length ? configured : [30000, 90000, 180000];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGeminiCapacityError(error) {
  if (!error || error.provider !== "gemini") return false;
  const text = [
    error.code,
    error.message,
    typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || {}),
  ]
    .join(" ")
    .toLowerCase();
  return (
    [429, 500, 503].includes(Number(error.status)) &&
    /high demand|overloaded|temporarily unavailable|try again later|resource_exhausted|unavailable|rate limit/.test(text)
  );
}

function isGeminiModelOnCooldown(model) {
  const until = geminiModelCooldowns.get(model) || 0;
  if (until > Date.now()) return true;
  if (until) geminiModelCooldowns.delete(model);
  return false;
}

function getGeminiModelCooldownRemainingMs(model) {
  const until = geminiModelCooldowns.get(model) || 0;
  const remaining = until - Date.now();
  if (remaining > 0) return remaining;
  if (until) geminiModelCooldowns.delete(model);
  return 0;
}

function putGeminiModelOnCooldown(model, error) {
  if (!model) return;
  const until = Date.now() + getGeminiModelCooldownMs();
  geminiModelCooldowns.set(model, until);
  console.warn(
    `Gemini model ${model} is temporarily on cooldown until ${new Date(until).toISOString()}: ${error?.message || ""}`
  );
}

function toFriendlyGeminiError(error, fallbackTried = false) {
  if (!isGeminiCapacityError(error)) return error;
  const friendly = createHttpError(
    503,
    "GEMINI_MODEL_BUSY",
    fallbackTried
      ? "Gemini当前模型繁忙，备用模型也未能及时返回。请稍后再试，或先换一道较短的题目测试。"
      : "Gemini高质量模型当前繁忙，系统将自动切换备用模型。"
  );
  friendly.provider = "gemini";
  friendly.model = error.model;
  friendly.detail = error.detail || error.message;
  return friendly;
}

async function generateMistakeGeminiTextWithFallback({
  model,
  fallbackModel = getMistakeGeminiModel("fast"),
  stage = "mistake",
  ...options
}) {
  const primaryModel = model || getMistakeGeminiModel("high");
  const secondaryModel = fallbackModel && fallbackModel !== primaryModel ? fallbackModel : "";
  let lastError = null;

  if (!isGeminiModelOnCooldown(primaryModel)) {
    try {
      const text = await generateGeminiText({ ...options, model: primaryModel });
      return { text, model: primaryModel, usedFallback: false, stage };
    } catch (error) {
      lastError = error;
      if (!isGeminiCapacityError(error)) throw error;
      putGeminiModelOnCooldown(primaryModel, error);
    }
  }

  if (secondaryModel) {
    try {
      const text = await generateGeminiText({ ...options, model: secondaryModel });
      return { text, model: secondaryModel, usedFallback: true, fallbackFrom: primaryModel, stage };
    } catch (error) {
      lastError = error;
      if (isGeminiCapacityError(error)) putGeminiModelOnCooldown(secondaryModel, error);
      throw toFriendlyGeminiError(error, true);
    }
  }

  throw toFriendlyGeminiError(lastError || createHttpError(503, "GEMINI_MODEL_BUSY", "Gemini模型当前繁忙，请稍后再试。"), false);
}

async function generateMistakeGeminiTextWithRetry({
  model,
  stage = "mistake",
  retryDelaysMs = getGeminiMistakeRetryDelaysMs(),
  ...options
}) {
  const primaryModel = model || getMistakeGeminiModel("high");
  let lastError = null;
  const attempts = Math.max(1, retryDelaysMs.length + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const cooldownRemaining = getGeminiModelCooldownRemainingMs(primaryModel);
    if (cooldownRemaining > 0) {
      const waitMs = Math.min(cooldownRemaining, retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || cooldownRemaining);
      console.warn(`Gemini model ${primaryModel} is cooling down before ${stage}; waiting ${waitMs}ms.`);
      await sleep(waitMs);
    }
    try {
      const text = await generateGeminiText({ ...options, model: primaryModel });
      return { text, model: primaryModel, usedFallback: false, retried: attempt > 0, attempts: attempt + 1, stage };
    } catch (error) {
      lastError = error;
      if (!isGeminiCapacityError(error)) throw error;
      const delayMs = retryDelaysMs[attempt];
      putGeminiModelOnCooldown(primaryModel, error);
      if (delayMs === undefined) break;
      console.warn(`Gemini model ${primaryModel} busy during ${stage}; retrying after ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }

  const friendly = createHttpError(
    503,
    "GEMINI_HIGH_MODEL_BUSY",
    "高质量分析模型当前繁忙，系统已经自动排队重试但仍未成功。请稍后继续，不会生成低质量讲解。"
  );
  friendly.provider = "gemini";
  friendly.model = primaryModel;
  friendly.detail = lastError?.detail || lastError?.message || "";
  throw friendly;
}

function normalizeTextList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function getMistakeQuestionScopeText(questionScope = "auto") {
  const scope = String(questionScope || "auto").toLowerCase();
  if (scope === "q1") return "只讲第1问。如果题目没有小问，就讲整道题。";
  if (scope === "q2") return "只讲第2问。可以极简引用第1问结论，但不要重讲第1问。";
  if (scope === "q3") return "只讲第3问。可以极简引用前面结论；如果涉及分类讨论，只保留必要分类和结论。";
  if (scope === "all") return "讲全题，但每一问只保留一条最清楚的主线，避免过长。";
  return "自动判断。若题目有多问且学生没有指定，先给全题框架，再重点讲第1问，并提示可以选择其他小问继续。";
}

function getMistakeSimilarScopeText(questionScope = "auto") {
  const scope = String(questionScope || "auto").toLowerCase();
  if (scope === "q1") return "只锁定原题第1问作为训练锚点；不要围绕其他小问生成。";
  if (scope === "q2") return "只锁定原题第2问作为训练锚点；可以极简引用第1问结论，但训练题必须服务第2问的方法。";
  if (scope === "q3") return "只锁定原题第3问作为训练锚点；可以极简引用前面结论，但训练题必须服务第3问的方法。";
  if (scope === "all") return "锁定整道题的综合训练锚点；如果原题有多个小问，训练题可以有递进小问，但不要过长。";
  return "自动判断原题最值得训练的一问或核心方法，并把它锁定为训练锚点；不要同时铺开太多方法。";
}

function getMistakeKnowledgeBoundary({ subject, grade }) {
  const subjectText = String(subject || "");
  const gradeText = String(grade || "");
  if (!subjectText.includes("数学")) {
    return `必须按${gradeText || "所选年级"}学生已经学习过的${subjectText || "本科目"}知识讲解；不要使用明显超出当前年级的术语和方法。`;
  }
  if (/小学/.test(gradeText)) {
    return "知识边界：使用小学数学方法讲解，例如数形结合、算术关系、简单方程和基础几何；不要使用初中/高中术语作为主方法。";
  }
  if (/初中一年级|初一/.test(gradeText)) {
    return "知识边界：按初一学生讲解，主方法只能使用线段与角、平行/垂直、三角形基本性质、等腰/直角三角形、全等三角形和一元一次方程等已学内容。不要把相似三角形、勾股定理、二次函数、三角函数、圆、导数、向量作为主解法；若题目确实更适合高年级方法，只能提醒“这是高年级方法”，不能用它完成主讲解。";
  }
  if (/初中二年级|初二/.test(gradeText)) {
    return "知识边界：按初二学生讲解，优先使用全等、轴对称、一次函数、方程和初二范围内的几何性质；不要把二次函数、三角函数、圆、高中导数或向量作为主解法。";
  }
  if (/初中三年级|初三|中考/.test(gradeText)) {
    return "知识边界：按初三/中考范围讲解，可以使用相似、圆、二次函数等初中内容，但不要使用高中导数、向量、解析几何的高级方法作为主解法。";
  }
  if (/高中|高一|高二|高三|高考/.test(gradeText)) {
    return "知识边界：按高中教材和高考规范讲解，可以使用高中范围内的函数、解析几何、立体几何、数列、导数等方法；不要使用大学数学方法作为主解法。";
  }
  return "知识边界：严格按照学生选择的年级讲解；如果某个更高级方法更短，只能作为提醒，不能替代当前年级能理解的主解法。";
}

function getForbiddenKnowledgeTerms({ subject, grade }) {
  if (!String(subject || "").includes("数学")) return [];
  const gradeText = String(grade || "");
  if (/小学/.test(gradeText)) return ["全等三角形", "相似三角形", "勾股定理", "二次函数", "三角函数", "导数", "向量"];
  if (/初中一年级|初一/.test(gradeText)) return ["相似三角形", "勾股定理", "二次函数", "三角函数", "圆周角", "切线", "导数", "向量"];
  if (/初中二年级|初二/.test(gradeText)) return ["二次函数", "三角函数", "圆周角", "切线", "导数", "向量"];
  if (/初中三年级|初三|中考/.test(gradeText)) return ["导数", "向量", "复数", "数列", "立体几何"];
  if (/高中|高一|高二|高三|高考/.test(gradeText)) return ["微积分", "矩阵", "群论"];
  return [];
}

function auditMistakeExplanation(text, { subject, grade }) {
  const source = String(text || "").trim();
  const problems = [];
  if (!source) problems.push("讲解为空");
  if (!/题目在考什么/.test(source)) problems.push("缺少“题目在考什么”");
  if (!/解题思路/.test(source)) problems.push("缺少“解题思路”");
  if (!/(具体解题过程|规范解答|解题过程)/.test(source)) problems.push("缺少具体解题过程");
  if (!/(最后答案|最终答案|答案[：:]|结论[：:]|所以.{0,30}(成立|相等|得|为|是|=|≌))/.test(source)) problems.push("缺少结论或答案");
  if (/这个思路错了|换个思路|看起来不通|重新思考|试试看|可能哪里没发现|这个不好用|不太好/.test(source)) {
    problems.push("出现草稿推理或自我否定语气");
  }
  if (/\\triangle|\\angle|\\frac|\$/.test(source)) problems.push("包含不适合学生阅读的 LaTeX 代码");
  const forbiddenTerms = getForbiddenKnowledgeTerms({ subject, grade }).filter((term) => source.includes(term));
  if (forbiddenTerms.length) problems.push(`使用了超出${grade || "当前年级"}的知识点：${forbiddenTerms.join("、")}`);
  const looksCutOff = !/[。！？.!?）)]$/.test(source) || /[,，、；;：:]$/.test(source);
  if (looksCutOff) problems.push("讲解疑似没有讲完");
  return { ok: problems.length === 0, problems };
}

const mistakeReportHeadings = [
  "题目识别",
  "题目在问什么",
  "考点定位",
  "知识点",
  "条件整理",
  "已知条件",
  "解题目标",
  "核心思路",
  "核心模型",
  "核心模型分析",
  "模型分析",
  "标准步骤",
  "解题步骤",
  "第一问解析",
  "第1问解析",
  "第一问",
  "第二问解析",
  "第2问解析",
  "第二问",
  "第三问解析",
  "第3问解析",
  "第三问",
  "分问解析",
  "详细解析",
  "标准证明",
  "明确答案",
  "最终答案",
  "标准答案",
  "类似题",
  "试卷分析",
  "错题清单",
  "优先处理顺序",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHeadingBlock(text, heading) {
  const source = String(text || "");
  const escaped = escapeRegExp(heading);
  const stopPattern = mistakeReportHeadings.map(escapeRegExp).join("|");
  const headingPattern = `(?:^|\\n)\\s*(?:【\\s*${escaped}[^】]*】|#{1,4}\\s*${escaped}[^\\n]*|${escaped}[^\\n]{0,40}[：:])`;
  const nextHeadingPattern = `(?:\\n\\s*(?:【\\s*(?:${stopPattern})[^】]*】|#{1,4}\\s*(?:${stopPattern})[^\\n]*|(?:${stopPattern})[^\\n]{0,40}[：:]))`;
  const match = source.match(new RegExp(`${headingPattern}\\s*([\\s\\S]*?)(?=${nextHeadingPattern}|$)`, "i"));
  return match ? match[1].trim() : "";
}

function extractFirstHeadingBlock(text, headings) {
  for (const heading of headings) {
    const block = extractHeadingBlock(text, heading);
    if (block) return block;
  }
  return "";
}

function compactReportSummary(...values) {
  const text = values
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!text) return "";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function normalizeStudentMathText(value) {
  let text = String(value || "");
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\triangle\s*([A-Za-z0-9]+)/g, "△$1")
    .replace(/\\angle\s*([A-Za-z0-9]+)/g, "∠$1")
    .replace(/\\cong/g, "≌")
    .replace(/\\perp/g, "⟂")
    .replace(/\\parallel/g, "∥")
    .replace(/\\circ/g, "°")
    .replace(/\\neq/g, "≠")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\Rightarrow/g, "⇒")
    .replace(/\\rightarrow/g, "→")
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function compactRepeatedMistakeText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lines = text.split(/\n/);
  const seen = new Map();
  const output = [];
  let truncated = false;

  for (const line of lines) {
    const key = line
      .replace(/\s+/g, "")
      .replace(/[，。；：、,.!！?？\-_*`#()[\]{}（）【】]/g, "")
      .trim();
    const shouldTrack = key.length >= 16;
    const count = shouldTrack ? seen.get(key) || 0 : 0;
    if (shouldTrack && count >= 2) {
      truncated = true;
      break;
    }
    if (shouldTrack) seen.set(key, count + 1);
    output.push(line);
  }

  let compacted = output.join("\n").trim();
  if (compacted.length > 9000) {
    compacted = `${compacted.slice(0, 9000).trim()}\n\n【系统提示】AI讲解内容过长，已保留前面的主要内容。建议重新生成时补充“请更简洁”。`;
  } else if (truncated) {
    compacted = `${compacted}\n\n【系统提示】AI输出出现重复，已自动截断。建议补充更清晰的题目材料后重新生成。`;
  }
  return compacted;
}

function splitTeacherSteps(block) {
  const clean = String(block || "").trim();
  if (!clean) return [];
  const lines = clean
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceLines = lines.length > 1 ? lines : clean.split(/(?=(?:第?\d+[步、.．:]|\d+[、.．]))/).map((line) => line.trim()).filter(Boolean);
  return sourceLines
    .map((line, index) => {
      const cleaned = line.replace(/^(?:第?(\d+)[步、.．:]|\d+[、.．])\s*/, "").trim();
      return { step: `第${index + 1}步`, explanation: cleaned || line };
    })
    .filter((item) => item.explanation)
    .slice(0, 8);
}

function normalizeMistakePlainTextReport(reportText, fallback = {}) {
  const text = compactRepeatedMistakeText(normalizeStudentMathText(reportText));
  if (!text) {
    throw createHttpError(502, "GEMINI_EMPTY_REPORT", "Gemini没有识别出题目内容，请换一张更清晰的图片或补充题干文字。");
  }
  const title = fallback.title && fallback.title !== "新上传学习材料" ? fallback.title : "错题分析";
  const recognitionText = compactRepeatedMistakeText(normalizeStudentMathText(fallback.recognitionText || ""));
  const sections = [];
  if (recognitionText) sections.push({ title: "AI识别到的题目", content: recognitionText });
  sections.push({ title: "AI讲解", content: text });
  return {
    title,
    summary: recognitionText ? "AI已先识别题目，再完成错题讲解。" : "AI已完成错题讲解。",
    teacher_explanation: {
      question_restate: "",
      test_point: "",
      known_conditions: [],
      target: "",
      core_idea: "",
      standard_steps: [],
      final_answer: "",
    },
    sections,
    extracted_questions: [],
    similar_questions: [],
    archive_note: "",
    meta: {
      provider: fallback.provider || "gemini",
      model: fallback.model || "",
      taskType: fallback.taskType || "",
      normalized: true,
      source: recognitionText ? "two_stage_plain_text" : "plain_text_raw",
    },
  };
}

function normalizeMistakeWorkflowReport(reportText, fallback = {}) {
  const parsed = parseJsonText(reportText, {});
  const rawText = parsed.rawText || (!Object.keys(parsed).length ? String(reportText || "").trim() : "");
  if (rawText) {
    throw createHttpError(502, "GEMINI_JSON_PARSE_FAILED", "Gemini返回的结构化结果不完整，请补充更清晰的题目材料后重新生成。");
  }
  const extractedQuestions = Array.isArray(parsed.extracted_questions) ? parsed.extracted_questions : [];
  const firstQuestion = extractedQuestions[0] || {};
  const teacherExplanation = parsed.teacher_explanation || firstQuestion.teacher_explanation || {};
  const standardSteps = Array.isArray(teacherExplanation.standard_steps)
    ? teacherExplanation.standard_steps.map((step, index) =>
        typeof step === "string"
          ? { step: `第${index + 1}步`, explanation: step }
          : { step: String(step?.step || `第${index + 1}步`).trim(), explanation: String(step?.explanation || "").trim() }
      )
    : Array.isArray(firstQuestion.correction_steps)
      ? firstQuestion.correction_steps.map((step, index) => ({ step: `第${index + 1}步`, explanation: step }))
      : normalizeTextList(firstQuestion.correction_steps).map((step, index) => ({ step: `第${index + 1}步`, explanation: step }));
  const normalizedTeacherExplanation = {
    question_restate: teacherExplanation.question_restate || firstQuestion.question_content || "",
    test_point: teacherExplanation.test_point || firstQuestion.test_point || normalizeTextList(firstQuestion.knowledge_points).join("、"),
    known_conditions: normalizeTextList(teacherExplanation.known_conditions || firstQuestion.known_conditions),
    target: teacherExplanation.target || firstQuestion.target || "",
    core_idea: teacherExplanation.core_idea || firstQuestion.method_gap || "",
    standard_steps: standardSteps,
    final_answer: teacherExplanation.final_answer || firstQuestion.standard_answer || "",
  };
  const sections = Array.isArray(parsed.sections) ? parsed.sections.filter((item) => item?.title || item?.content) : [];
  const priorityOrder = normalizeTextList(parsed.priority_order);
  if (priorityOrder.length) sections.push({ title: "优先处理顺序", content: priorityOrder.join("；") });
  return {
    title: parsed.title || fallback.title || "错题专项分析",
    summary: parsed.summary || "AI已完成本次错题专项处理。",
    teacher_explanation: normalizedTeacherExplanation,
    sections,
    extracted_questions: extractedQuestions,
    similar_questions: Array.isArray(parsed.similar_questions) ? parsed.similar_questions : [],
    archive_note: parsed.archive_note || "",
    meta: {
      ...(parsed.meta || {}),
      provider: fallback.provider || "gemini",
      model: fallback.model || getMistakeGeminiModel(fallback.qualityMode),
      taskType: fallback.taskType || "",
      normalized: true,
    },
  };
}

function buildMistakeWorkflowPrompt({ taskType, taskText, subject, grade, title, source, prompt, archiveSnapshot, documentText, questionScope }) {
  const studentGrade = grade || "学生当前年级";
  const subjectText = subject || "未指定科目";
  const knowledgeBoundary = getMistakeKnowledgeBoundary({ subject, grade });
  const common = [
    "你是树子AI错题专项老师。请严格根据上传材料和学生补充来处理，不要编造看不清的题干。",
    "请使用中文自然语言输出，不要输出JSON，不要输出Markdown表格，不要出现英文字段名。",
    `任务类型：${taskText}`,
    `科目：${subjectText}`,
    `题目所属年级：${grade || "未指定"}`,
    `讲解对象：对面是一名${studentGrade}学生，请围绕${subjectText}学习，用这个年级能听懂的语言、知识范围和解题方法来讲。`,
    `标题：${title}`,
    `来源：${source}`,
    `学生补充要求：${prompt}`,
    `学生档案摘要：${archiveSnapshot}`,
    `上传文档文字摘录：\n${documentText || "无可提取文档文字；如有图片或PDF，请结合附件内容分析。"}`,
  ];
  if (taskType === "generateSimilar") {
    return [
      "你现在只做“生成类似题”，不要分析原题错因，不要分析整张试卷。",
      jsonInstruction("{title:string, summary:string, similar_questions:[{title:string, question:string, answer:string, solution_steps:[string], training_goal:string, difficulty:string}]}"),
      `生成范围：${getMistakeSimilarScopeText(questionScope)}`,
      `年级硬性限制：所有训练题必须是${studentGrade}学生可以学习和完成的${subjectText}题；题干、知识点、解法和答案步骤都不能超出这个年级常规知识范围。`,
      knowledgeBoundary,
      "生成前必须先锁定训练锚点：当前范围里的考查目标、题目任务、材料或情境类型、核心方法、关键条件结构、答案形式和难度层级。",
      "硬规则一：科目和年级一致。数学、物理、化学、语文、英语等不同科目要使用本学科当前年级的常规题目表达和知识边界。",
      "硬规则二：任务形式一致。原题如果是计算、证明、解释原因、实验分析、现象判断、概念辨析、阅读理解、写作表达、选择判断或推断题，训练题也必须保持同类任务形式，不要换成另一类问题。",
      "硬规则三：核心方法一致。训练题要训练同一种处理方法、思路结构或关键突破口；不要只是改数字，也不要只生成同知识点但方法不同的题。",
      "硬规则四：答案形式一致。原题要求求数值、范围、原因、结论、证明、实验现象、选项判断或表达修改，训练题也要保持相近的答案形式。",
      "summary必须用一句话说明本次锁定的训练锚点，例如“本次围绕第2问的××任务形式和××方法生成训练题”。",
      "每道题必须包含题目、答案、简要步骤和训练目的；训练目的要明确指出它训练的是哪一种方法、模型或思维动作。",
      "如果原题本身疑似超出当前年级，请把训练题降到当前年级可掌握的同类方法；如果原题看不清或条件不足，请说明无法准确生成，并请求学生重新上传更清楚的题目。",
      ...common,
    ].join("\n");
  }
  if (taskType === "analyzePaper") {
    return [
      "你现在只做“分析试卷/作业”，不要给单题做长篇讲解，不要生成类似题。",
      jsonInstruction("{title:string, summary:string, sections:[{title:string, content:string}], extracted_questions:[{id:string,title:string,question_content:string,subject:string,error_type:string,knowledge_points:[string],method_gap:string,correction_steps:[string],standard_answer:string,suggestion:string,is_likely_wrong:boolean}], priority_order:[string], archive_note:string}"),
      "试卷分析的目标是形成学习诊断报告，不是批量讲题。你只能根据图片、PDF、作答痕迹、批改痕迹、分数、题号和学生补充做分析；看不清或没有证据的地方必须说“需要确认”，不要猜测。",
      "请区分“可见线索”和“可能原因”：不能直接给学生贴标签，不能说粗心、不认真、基础差；要写成“从第几题/哪类题的可见表现看，可能存在……，需要通过……确认”。",
      "sections请固定输出这些板块：1.试卷整体判断；2.可见问题线索；3.可能原因与待确认点；4.优先处理顺序；5.下一步训练建议。",
      "extracted_questions用于整理需要关注的题目或题组。字段含义请按试卷分析理解：error_type写“可见线索”，method_gap写“可能原因（需确认）”，correction_steps写“确认方式或下一步动作”，suggestion写“具体训练建议”。",
      "每条问题必须尽量绑定题号、题组、分数、批改痕迹或学生作答痕迹；如果看不清题号或作答，请明确标注“题号/作答不清，需要补充”。",
      "priority_order只写优先处理顺序，不要写完整周计划。顺序应体现：先处理证据最明确、影响最大、最容易提分的问题，再处理需要长期训练的问题。",
      ...common,
    ].join("\n");
  }
  return [
    `请帮一名${studentGrade}学生讲解这道${subjectText}题。先判断题目大致考查的知识点，然后像老师上课一样自然讲解，目标是让学生听懂。`,
    "请先尽量读出图片中的题目；如果有看不清的地方，只说明看不清的位置，然后基于能看清的信息继续讲。",
    "讲解时请包含：这道题在问什么、核心思路或模型、每一问的解题框架、关键证明或计算步骤、最后答案。",
    "如果题目涉及多种位置、多种情况或分类讨论，请给出清楚的分类框架；每一种情况都要有必要推导、关键关系和结论，但不要重复已经证明过的内容。",
    "每一问只保留一种最清楚的解法；不要重复讲解，不要反复推翻自己的思路，不要罗列多套备选方法。",
    "如果题目有多个小问，请按小问分别讲解。不要只复述题目，也不要只给结论。内容完整优先，但整体控制在2500字以内。",
    "如果某一步确实无法判断、图片条件不足或做不出来，请明确说明哪里不确定，不要硬编条件、过程或答案。",
    "请使用中文自然语言，可以使用普通数学符号，例如 △ABC、∠ACB=90°、CA=CB、△BCD≌△EFB。",
    "不要使用Markdown格式，不要使用LaTeX公式，不要写 $...$、\\triangle、\\angle、\\frac 这一类代码。不要输出JSON，不要输出英文字段名。",
    ...common,
  ].join("\n");
}

function compactForPrompt(value, maxLength = 7000) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildMistakeFollowUpPrompt({ subject = "", grade = "", title = "", question = "", report = {}, history = [], questionScope = "auto" } = {}) {
  const recentHistory = Array.isArray(history)
    ? history
        .slice(-6)
        .map((item, index) => `第${index + 1}轮：学生问：${item.question || ""}\nAI答：${item.answer || ""}`)
        .join("\n\n")
    : "";
  return [
    "你是树子AI错题专项老师。现在是学生看完上一份错题讲解后的继续追问，不是首次上传分析。",
    "严禁重新走错题图片识别流程，严禁重新生成完整错题报告，严禁生成相似题，严禁输出JSON。",
    "只围绕学生本轮追问回答；如果追问涉及某一步，就把那一步讲清楚；如果学生表达了自己的想法，先判断这个想法哪里对、哪里需要修正。",
    "讲解要像老师面对学生继续讲题：中文自然表达，步骤清楚，控制在1200字以内。",
    getMistakeKnowledgeBoundary({ subject, grade }),
    `科目：${subject || "未指定"}`,
    `年级：${grade || "未指定"}`,
    `标题：${title || "当前错题"}`,
    `讲解范围：${getMistakeQuestionScopeText(questionScope)}`,
    `当前错题报告摘要：${compactForPrompt(report, 7000)}`,
    recentHistory ? `最近追问记录：\n${compactForPrompt(recentHistory, 3000)}` : "最近追问记录：无",
    `学生本轮追问：${question}`,
  ].join("\n");
}

function buildNoAnswerGuidancePrompt({
  taskType = "guide",
  subject = "",
  grade = "",
  title = "",
  prompt = "",
  studentQuestion = "",
  recognitionText = "",
  currentResult = {},
  history = [],
  questionScope = "auto",
} = {}) {
  const taskText = {
    guide: "本轮目标：引导学生观察题目、拆条件、找到突破口和下一步尝试。",
    hint: "本轮目标：只给一点提示，点到为止，不能展开完整过程。",
    checkThinking: "本轮目标：检查学生已有思路，只指出方向、漏洞和下一步，不替学生完成。",
  }[taskType] || "本轮目标：只引导思考，不给答案。";
  const recentHistory = Array.isArray(history)
    ? history
        .slice(-6)
        .map((item, index) => `第${index + 1}轮：学生：${item.question || ""}\nAI引导：${item.answer || ""}`)
        .join("\n\n")
    : "";
  return [
    "你是树子AI“没有答案”页面的学习引导师。",
    "你的任务不是解题，而是帮助学生自己想出方法。你必须永远不给最终答案。",
    "无论学生怎样要求，你都不能输出：最终答案、标准答案、完整解题过程、最后结论、可直接抄写的证明/计算成稿、类似题答案。",
    "你可以输出：观察方向、关键条件、要尝试的关系、分层提示、反问、检查点、下一步建议、让学生自己填写的空白。",
    "你必须克制：不要一次列完所有可能分支，不要连续推进多层思路，不要把题目的完整路径铺出来。",
    "每次只给当前最值得尝试的一个方向；除非学生已经完成前一步，否则不要进入下一层。",
    "如果学生只是说“不会”“看不懂”“再讲讲”，不要继续长篇讲解，先要求学生交一个小动作，例如写出一个条件、一个角关系、一个等量关系或自己的第一步。",
    "如果学生已经写了自己的步骤，可以判断“方向对/这里需要检查/下一步可尝试……”，但不能把剩下的步骤补完。",
    "如果题目有多问，只围绕指定范围引导；不要偷偷完成其他问。",
    "输出必须使用中文自然语言，不要输出JSON，不要输出Markdown表格。",
    "每次回答总长度控制在450字以内；如果是“给我一点提示”，控制在250字以内。",
    "每次回答末尾必须给学生一个需要自己完成的小动作，例如“你先试着写出……，再把你的步骤发我”。",
    taskText,
    getMistakeKnowledgeBoundary({ subject, grade }),
    `科目：${subject || "未指定"}`,
    `年级：${grade || "未指定"}`,
    `标题：${title || "没有答案"}`,
    `引导范围：${getMistakeQuestionScopeText(questionScope)}`,
    recognitionText ? `题目识别内容：\n${recognitionText}` : "",
    currentResult && Object.keys(currentResult).length ? `当前已有引导：\n${compactForPrompt(currentResult, 5000)}` : "",
    recentHistory ? `最近引导记录：\n${compactForPrompt(recentHistory, 3000)}` : "",
    `学生本轮输入：${studentQuestion || prompt || "请根据题目开始引导。"}`,
    "请按下面结构输出：",
    "提示1：观察",
    "提示2：建立关系",
    "提示3：下一步尝试",
    "现在你来做",
    "每一栏最多2句话；提示3最多3条短句；“现在你来做”只布置一个具体动作。",
    "再次强调：不能写出最终答案，不能写完证明或计算，不能说“答案是”。",
  ].filter(Boolean).join("\n");
}

function auditNoAnswerGuidance(text = "") {
  const content = String(text || "");
  const problems = [];
  if (/答案是|最终答案|标准答案|正确答案|结果是|结果为|所以答案|因此答案/.test(content)) {
    problems.push("疑似直接给出答案或结果");
  }
  if (/完整解答|完整解析|标准解法|解题过程如下|证明如下/.test(content)) {
    problems.push("疑似输出完整解题过程");
  }
  if (/^\s*(答|解)[:：]/m.test(content)) {
    problems.push("疑似使用答案式开头");
  }
  if (content.length > 900) {
    problems.push("回答过长，疑似过度展开");
  }
  return { ok: problems.length === 0, problems };
}

function buildNoAnswerRepairPrompt({ previousText = "", auditProblems = [], guidancePrompt = "" } = {}) {
  return [
    "下面这段“没有答案”引导文本违反了规则，需要重写。",
    `违规点：${auditProblems.join("；") || "疑似给出答案"}`,
    "重写要求：删除最终答案、标准答案、完整步骤和可抄成稿内容；只保留观察方向、提示、反问、检查点和下一步让学生自己完成的动作。",
    "重写后控制在450字以内；只给一个当前最值得尝试的方向，不要列完所有分支。",
    "固定使用这四个标题：提示1：观察；提示2：建立关系；提示3：下一步尝试；现在你来做。",
    "原始任务提示：",
    guidancePrompt,
    "需要重写的文本：",
    previousText,
  ].join("\n");
}

function buildMistakeRecognitionPrompt({ subject, grade, title, prompt, documentText }) {
  return [
    "你现在只做第一步：识别题目。",
    "请根据上传的图片、PDF或文字材料，整理出题目本身，不要讲解，不要求解，不要猜答案。",
    "如果有几何图，请尽量识别点、线、角、相等关系、垂直或平行关系、动点位置和每一问的要求。",
    "如果图片有看不清的地方，请直接写明“看不清：……”，不要编造。",
    "输出使用中文自然语言，按下面四项写：",
    "题干：",
    "已知条件：",
    "要求：",
    "看不清或不确定：",
    `科目：${subject || "未指定"}`,
    `题目所属年级：${grade || "未指定"}`,
    `标题：${title || "错题"}`,
    `学生补充：${prompt || "无"}`,
    `文档文字摘录：\n${documentText || "无可提取文档文字；请主要结合附件内容识别。"}`,
  ].join("\n");
}

function buildMistakeExplanationPrompt({ subject, grade, title, prompt, recognitionText, questionScope }) {
  const studentGrade = grade || "学生当前年级";
  const subjectText = subject || "未指定科目";
  return [
    "你现在只做第二步：讲解题目。第一步已经识别了题目，你不要重新识别图片，也不要额外猜题。",
    `请像一位有经验的${subjectText}老师，给一名${studentGrade}学生讲清楚这道题。目标是让学生听懂思路，并知道考试时怎么写。`,
    "你不是在展示解题探索过程，而是在输出一份给学生看的最终讲解稿。",
    "请先在内部完整解题并检查一遍，但不要输出内部思考过程、草稿推理、错误尝试或自我否定。",
    getMistakeKnowledgeBoundary({ subject, grade }),
    `讲解范围：${getMistakeQuestionScopeText(questionScope)}`,
    "如果题目条件识别不完整，先说明缺少哪一处；能合理继续就基于明确假设继续，不能合理继续就直接说明需要补充材料，不要硬编。",
    "最终输出只能包含下面四个板块，板块标题请照写：",
    "## 1. 题目在考什么",
    "## 2. 解题思路",
    "## 3. 具体解题过程",
    "## 4. 易错提醒",
    "各板块要求：",
    "- 题目在考什么：最多3句话，只说核心考点和题型，不复述整道题。",
    "- 解题思路：用3到5条说明主线，先讲为什么这样做，再讲每一问大致怎么推进。",
    "- 具体解题过程：按题目小问编号讲解。每一问必须包含“目标：”“关键关系：”“推导过程：”“结论：”。",
    "- 易错提醒：最多3条，只写学生最容易错在哪里、下次怎么避免。",
    "严禁输出：",
    "- “这个思路错了”“换个思路”“看起来不通”“我们重新思考”“试试看”“可能哪里没发现”等探索或犹豫语气。",
    "- 多套互相推翻的做法、无结论的试算、重复证明、为了凑字数的长篇解释。",
    "- AI识别题目的完整原文，前端已经单独展示，不要重复占版面。",
    "解题规则：",
    "- 多小问按题目顺序讲；涉及分类讨论时，只列必要情况，每种情况给关键推导和结论。",
    "- 每一问只保留一种最清楚的解法，不要反复尝试、不要推翻自己、不要重复已经证明过的内容。",
    "- 如果某一问条件不足，直接写“这一问目前条件不足，不能严谨推出”，并说明缺少什么；不要硬编辅助线、条件或答案。",
    "- 讲解要适合所选年级，不要超出这个年级太多。",
    "- 不要使用Markdown表格，不要输出JSON，不要出现英文字段名。",
    "- 不要使用LaTeX代码，不要写 $...$、\\triangle、\\angle、\\frac；数学符号尽量用普通文字表达。",
    "- 不要使用“∵”“∴”，请写“因为”“所以”。",
    "- 整体控制在2500字以内。",
    `科目：${subjectText}`,
    `题目所属年级：${grade || "未指定"}`,
    `标题：${title || "错题"}`,
    `学生补充要求：${prompt || "无"}`,
    `第一步识别到的题目：\n${recognitionText || "未识别到题目。请说明无法讲解。"}`,
  ].join("\n");
}

function buildMistakeRepairPrompt({ subject, grade, title, prompt, recognitionText, questionScope, previousText, auditProblems }) {
  const subjectText = subject || "未指定科目";
  const studentGrade = grade || "学生当前年级";
  return [
    "上一版讲解没有通过产品自检，请你重写一版最终讲解稿。不要解释为什么重写。",
    `对象：${studentGrade}学生；科目：${subjectText}。`,
    getMistakeKnowledgeBoundary({ subject, grade }),
    `讲解范围：${getMistakeQuestionScopeText(questionScope)}`,
    `自检发现的问题：${(auditProblems || []).join("；")}`,
    "必须修正：不要使用超出当前年级的主方法；不要输出草稿推理；不要重复；必须有结论或答案；整体不要超过2500字。",
    "输出板块只能是：",
    "## 1. 题目在考什么",
    "## 2. 解题思路",
    "## 3. 具体解题过程",
    "## 4. 易错提醒",
    "具体解题过程按小问写，每一问使用：目标、关键关系、推导过程、结论。",
    `标题：${title || "错题"}`,
    `学生补充要求：${prompt || "无"}`,
    `题目识别结果：\n${recognitionText || "未识别到题目。"}`,
    `上一版讲解：\n${String(previousText || "").slice(0, 5000)}`,
  ].join("\n");
}

function getErrorDetail(error) {
  return typeof error.detail === "string"
    ? error.detail
    : error.detail?.message || error.detail?.error?.message || error.message;
}

function serializeJobError(error) {
  return {
    code: error.code || "AI_JOB_FAILED",
    message: error.status ? error.message : "服务器处理失败。",
    detail: getErrorDetail(error),
    provider: error.provider || undefined,
    model: error.model || undefined,
    status: error.status || 500,
  };
}

function normalizeStableValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeStableValue);
  const entries = Object.entries(value)
    .filter(([key]) => !["path", "url", "data", "base64", "content"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, item]) => [key, normalizeStableValue(item)]));
}

function stableStringify(value) {
  return JSON.stringify(normalizeStableValue(value));
}

function createRequestHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function parseMaybeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberFromPaths(source, paths) {
  for (const pathItems of paths) {
    let cursor = source;
    for (const key of pathItems) cursor = cursor?.[key];
    const value = Number(cursor);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function getTextPricing(model) {
  const modelKey = String(model || "").toLowerCase();
  const prices = tokenBillingRules.textPricingUsdPer1M || {};
  if (prices[modelKey]) return prices[modelKey];
  const matchedKey = Object.keys(prices)
    .sort((a, b) => b.length - a.length)
    .find((key) => modelKey.startsWith(key));
  return matchedKey ? prices[matchedKey] : null;
}

function createOpenAIUsageEvent(response, model, kind = "text") {
  return {
    provider: "openai",
    model,
    kind,
    usage: response?.usage || {},
  };
}

function createImageUsageEvent({ model = imageModel, quality = imageQuality, size = imageSize } = {}) {
  return {
    provider: "openai",
    model,
    kind: "image",
    usage: { images: 1, quality, size },
  };
}

function makeFileDedupeMeta(files = []) {
  return (files || []).map((file) => ({
    originalname: file.originalname || file.filename || "",
    mimetype: file.mimetype || "",
    size: file.size || 0,
  }));
}

function estimateTextCostUsd(event) {
  const pricing = getTextPricing(event?.model);
  if (!pricing) return 0;
  const usage = event?.usage || {};
  const provider = String(event?.provider || "").toLowerCase();
  let input = 0;
  let output = 0;
  let cachedInput = 0;
  if (provider === "gemini") {
    input = Number(usage.promptTokenCount || 0);
    output = Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0);
    cachedInput = Number(usage.cachedContentTokenCount || 0);
  } else {
    input = numberFromPaths(usage, [["input_tokens"], ["prompt_tokens"]]);
    output = numberFromPaths(usage, [["output_tokens"], ["completion_tokens"]]);
    cachedInput = numberFromPaths(usage, [
      ["input_tokens_details", "cached_tokens"],
      ["prompt_tokens_details", "cached_tokens"],
      ["input_token_details", "cached_tokens"],
    ]);
  }
  const uncachedInput = Math.max(0, input - cachedInput);
  return (
    (uncachedInput * Number(pricing.input || 0) +
      cachedInput * Number(pricing.cachedInput ?? pricing.input ?? 0) +
      output * Number(pricing.output || 0)) /
    1_000_000
  );
}

function estimateImageCostUsd(event) {
  const usage = event?.usage || {};
  const modelPrices = tokenBillingRules.imagePricingUsd?.[event?.model] || tokenBillingRules.imagePricingUsd?.[imageModel];
  if (!modelPrices) return 0;
  const sizePrices = modelPrices[usage.size] || modelPrices.default || {};
  const unitPrice = Number(sizePrices[usage.quality] ?? sizePrices.medium ?? 0);
  return unitPrice * Math.max(1, Number(usage.images || 1));
}

function estimateProviderCostUsd(usageEvents = []) {
  return usageEvents.reduce((sum, event) => {
    if (event?.kind === "image") return sum + estimateImageCostUsd(event);
    return sum + estimateTextCostUsd(event);
  }, 0);
}

async function recordAiUsageBilling(userId, { jobId = "", note = "AI usage", usageEvents = [], fallbackTokenCost = 0, meta = {} } = {}) {
  const providerCostUsd = estimateProviderCostUsd(usageEvents);
  const providerCostCny = providerCostUsd * Number(tokenBillingRules.usdToCny || 0);
  const billableCny = providerCostCny * Number(tokenBillingRules.markup || 1);
  let billedTokens =
    providerCostUsd > 0
      ? Math.ceil(billableCny * Number(tokenBillingRules.tokensPerCny || 1))
      : Math.ceil(Number(fallbackTokenCost || 0));
  if (billedTokens > 0) billedTokens = Math.max(billedTokens, Number(tokenBillingRules.minimumChargeTokens || 1));
  const billing = {
    usageEvents,
    providerCostUsd: Number(providerCostUsd.toFixed(6)),
    providerCostCny: Number(providerCostCny.toFixed(4)),
    billableCny: Number(billableCny.toFixed(4)),
    billingMarkup: Number(tokenBillingRules.markup || 1),
    billedTokens,
    usedFallback: providerCostUsd <= 0,
  };
  if (billedTokens > 0) {
    await recordTokenUsage(userId, billedTokens, note, { ...meta, billing });
  }
  if (jobId) {
    await query(
      `UPDATE ai_generation_jobs
       SET usage = $2,
           provider_cost_usd = $3,
           provider_cost_cny = $4,
           billable_cny = $5,
           billing_markup = $6,
           billed_tokens = $7,
           token_cost = $7,
           updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        JSON.stringify({ events: usageEvents }),
        billing.providerCostUsd,
        billing.providerCostCny,
        billing.billableCny,
        billing.billingMarkup,
        billing.billedTokens,
      ]
    );
  }
  return billing;
}

function publicJob(row) {
  if (!row) return null;
  return {
    jobId: row.id,
    feature: row.feature,
    status: row.status,
    provider: row.provider || undefined,
    mode: row.mode || undefined,
    input: row.input || {},
    result: row.result || {},
    error: row.error || {},
    externalResponseId: row.external_response_id || undefined,
    tokenCost: row.token_cost || 0,
    requestHash: row.request_hash || undefined,
    usage: parseMaybeJson(row.usage, {}),
    providerCostUsd: Number(row.provider_cost_usd || 0),
    providerCostCny: Number(row.provider_cost_cny || 0),
    billableCny: Number(row.billable_cny || 0),
    billingMarkup: Number(row.billing_markup || tokenBillingRules.markup || 1),
    billedTokens: Number(row.billed_tokens || row.token_cost || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function createAiJob({
  userId,
  studentId,
  feature,
  provider = "",
  mode = "",
  tokenCost = 0,
  input = {},
  dedupeInput = null,
  requestHash = "",
  activeWindowMinutes = 30,
  reuseActive = true,
  reuseCompleted = true,
}) {
  const finalRequestHash =
    requestHash ||
    createRequestHash({
      studentId: studentId || "",
      feature,
      provider,
      mode,
      input: dedupeInput || input,
    });
  if (reuseActive) {
    const activeJob = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE user_id = $1
           AND feature = $2
           AND request_hash = $4
           AND status IN ('queued', 'processing')
           AND created_at > now() - ($3::text || ' minutes')::interval
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, feature, activeWindowMinutes, finalRequestHash]
      )
    ).rows[0];
    if (activeJob) return { job: activeJob, reused: true };
  }
  if (reuseCompleted && tokenBillingRules.completedJobReuseMinutes > 0) {
    const completedJob = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE user_id = $1
           AND feature = $2
           AND request_hash = $4
           AND status = 'completed'
           AND created_at > now() - ($3::text || ' minutes')::interval
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, feature, tokenBillingRules.completedJobReuseMinutes, finalRequestHash]
      )
    ).rows[0];
    if (completedJob) return { job: completedJob, reused: true };
  }
  const job = (
    await query(
      `INSERT INTO ai_generation_jobs (user_id, student_id, feature, status, input, provider, mode, token_cost, request_hash)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, studentId, feature, JSON.stringify(input), provider, mode, tokenCost, finalRequestHash]
    )
  ).rows[0];
  return { job, reused: false };
}

function startAiJob(jobId, executor) {
  setTimeout(async () => {
    try {
      await query("UPDATE ai_generation_jobs SET status = 'processing', updated_at = now() WHERE id = $1", [jobId]);
      const result = await executor({
        jobId,
        setExternalResponseId: async (externalResponseId) => {
          await query("UPDATE ai_generation_jobs SET external_response_id = $2, updated_at = now() WHERE id = $1", [jobId, externalResponseId]);
        },
      });
      await query(
        `UPDATE ai_generation_jobs
         SET status = 'completed', result = $2, updated_at = now(), completed_at = now()
         WHERE id = $1`,
        [jobId, JSON.stringify(result || {})]
      );
    } catch (error) {
      console.error("AI async job failed", jobId, error);
      await query(
        `UPDATE ai_generation_jobs
         SET status = 'failed', error = $2, updated_at = now(), completed_at = now()
         WHERE id = $1`,
        [jobId, JSON.stringify(serializeJobError(error))]
      );
    }
  }, 0);
}

async function waitForOpenAIBackgroundResponse(response, { jobId = "", timeoutMessage = "OpenAI后台任务仍未完成，请稍后查看。", pollMs = 3000, maxPolls = 60 } = {}) {
  if (jobId && response.id) {
    await query("UPDATE ai_generation_jobs SET external_response_id = $2, updated_at = now() WHERE id = $1", [jobId, response.id]);
  }
  let completed = response;
  for (let attempt = 0; attempt < maxPolls && ["queued", "in_progress"].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    completed = await openai.responses.retrieve(response.id);
  }
  if (["queued", "in_progress"].includes(completed.status)) {
    try {
      await openai.responses.cancel(response.id);
    } catch (error) {
      console.warn("Failed to cancel timed-out OpenAI background response", response.id, error.message);
    }
    const error = createHttpError(504, "OPENAI_BACKGROUND_TIMEOUT", timeoutMessage);
    error.detail = `response_id=${response.id}; status=${completed.status}; cancelled=true`;
    throw error;
  }
  if (completed.status !== "completed") {
    const error = createHttpError(502, "OPENAI_BACKGROUND_FAILED", "OpenAI后台任务失败。");
    error.detail = completed.error?.message || JSON.stringify(completed.error || { status: completed.status });
    throw error;
  }
  return completed;
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

function formatForumTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function toForumImage(file) {
  if (!file?.id) return null;
  return {
    id: file.id,
    name: file.original_name,
    url: `/api/forum/files/${file.id}`,
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes || 0),
  };
}

function toForumPost(row, replies = [], images = [], viewerUserId = "") {
  return {
    id: row.id,
    type: row.post_type,
    title: row.title,
    content: row.content,
    author: row.display_name || row.identifier || "会员同学",
    authorId: row.user_id,
    time: formatForumTime(row.created_at),
    likes: Number(row.likes || 0),
    isPinned: Boolean(row.is_pinned),
    pinnedAt: row.pinned_at || null,
    pinnedBy: row.pinned_by || "",
    lastActivityAt: row.last_activity_at || row.updated_at || row.created_at,
    canDelete: Boolean(viewerUserId && row.user_id === viewerUserId),
    images: images.map(toForumImage).filter(Boolean),
    replies,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOptionalForumViewer(req) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-only-change-me");
    return (await query("SELECT id, role FROM users WHERE id = $1", [payload.sub])).rows[0] || null;
  } catch {
    return null;
  }
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

const freeAskMaterialLimits = {
  maxFiles: Number(process.env.FREE_ASK_MAX_FILES || 8),
  maxImageFiles: Number(process.env.FREE_ASK_MAX_IMAGE_FILES || 5),
  maxImageBytes: Number(process.env.FREE_ASK_MAX_IMAGE_MB || 8) * 1024 * 1024,
  maxDocumentChars: Number(process.env.FREE_ASK_MAX_DOCUMENT_CHARS || 32000),
  maxCharsPerDocument: Number(process.env.FREE_ASK_MAX_CHARS_PER_DOCUMENT || 12000),
};

function isImageUpload(file) {
  return (file?.mimetype || "").startsWith("image/");
}

async function buildFreeAskMaterialContext(files = []) {
  const incoming = Array.isArray(files) ? files : [];
  const selected = incoming.slice(0, freeAskMaterialLimits.maxFiles);
  const skipped = incoming.slice(freeAskMaterialLimits.maxFiles).map((file) => file.originalname);
  const safeImageFiles = selected
    .filter((file) => isImageUpload(file) && Number(file.size || 0) <= freeAskMaterialLimits.maxImageBytes)
    .slice(0, freeAskMaterialLimits.maxImageFiles);
  const skippedLargeImages = selected
    .filter((file) => isImageUpload(file) && Number(file.size || 0) > freeAskMaterialLimits.maxImageBytes)
    .map((file) => file.originalname);
  const documentChunks = [];
  let usedChars = 0;

  for (const file of selected) {
    if (isImageUpload(file)) continue;
    const text = await extractDocumentText(file);
    const remaining = freeAskMaterialLimits.maxDocumentChars - usedChars;
    if (remaining <= 0) {
      skipped.push(file.originalname);
      continue;
    }
    const slice = String(text || "").slice(0, Math.min(remaining, freeAskMaterialLimits.maxCharsPerDocument));
    usedChars += slice.length;
    documentChunks.push(
      [
        `文件：${file.originalname}`,
        `类型：${file.mimetype || "未知"}`,
        slice ? `可读取内容摘录：\n${slice}` : "暂时没有提取到可读取文字。若这是扫描版PDF，请上传关键页面截图或补充你希望AI重点看的内容。",
      ].join("\n")
    );
  }

  const notes = [];
  if (safeImageFiles.length) notes.push(`已传入可识别图片 ${safeImageFiles.length} 张。`);
  if (skippedLargeImages.length) {
    notes.push(`以下图片较大，已避免直接传入模型：${skippedLargeImages.join("、")}。建议裁剪到题目或关键内容区域后重传。`);
  }
  if (skipped.length) {
    notes.push(`以下材料未直接进入本次AI上下文，避免一次请求过大：${skipped.join("、")}。`);
  }

  return {
    safeImageFiles,
    materialText: [notes.join("\n"), documentChunks.join("\n\n---\n\n")].filter(Boolean).join("\n\n").slice(0, 18000),
    fileSummary: incoming.length
      ? incoming.map((file) => `${file.originalname} (${file.mimetype || "unknown"}, ${file.size || 0} bytes)`).join(", ")
      : "no attachment",
  };
}

const freeAskSystemPrompt =
  "你是树子AI的自由对话助手。用户可能是学生，也可能是家长。你必须先判断用户本轮希望你对文字、图片或文件做什么，再选择回答方式。普通图片、截图和文档默认按内容理解、信息提取或总结来回答；只有用户明确要求讲题、解题、分析作业/试卷/错题时，才按学习题目讲解。保持中文表达，结构清楚，分段自然，便于学生和家长阅读。不要臆造看不清或没有提供的信息；材料不足时请说明需要补充什么。";

const freeAskMemoryLimits = {
  recentMessages: Number(process.env.FREE_ASK_RECENT_MESSAGES || 12),
  maxStoredMessages: Number(process.env.FREE_ASK_MAX_STORED_MESSAGES || 80),
  summarizeKeepMessages: Number(process.env.FREE_ASK_SUMMARIZE_KEEP_MESSAGES || 40),
  maxSummaryChars: Number(process.env.FREE_ASK_MAX_SUMMARY_CHARS || 1800),
  maxContextChars: Number(process.env.FREE_ASK_MAX_CONTEXT_CHARS || 12000),
};

function safeJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function toPublicFreeAskConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || "新的对话",
    memorySummary: row.memory_summary || "",
    messageCount: Number(row.message_count || 0),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicFreeAskMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content || "",
    attachments: safeJsonValue(row.attachments, []),
    meta: safeJsonValue(row.meta, {}),
    createdAt: row.created_at,
  };
}

function makeFreeAskTitle(question = "", files = []) {
  const fromQuestion = String(question || "").replace(/\s+/g, " ").trim();
  if (fromQuestion) return fromQuestion.slice(0, 28);
  const firstFileName = files?.[0]?.originalname || "";
  if (firstFileName) return firstFileName.replace(/\.[^.]+$/, "").slice(0, 28);
  return "新的对话";
}

function makeFreeAskAttachmentMeta(files = []) {
  return (files || []).map((file) => ({
    name: file.originalname,
    type: file.mimetype || "unknown",
    size: Number(file.size || 0),
  }));
}

async function ensureFreeAskConversation({ userId, studentId, conversationId, question, files }) {
  if (conversationId) {
    const existing = (
      await query(
        "SELECT * FROM free_ask_conversations WHERE id = $1 AND user_id = $2 AND is_archived = false",
        [conversationId, userId]
      )
    ).rows[0];
    if (existing) return existing;
  }
  return (
    await query(
      `INSERT INTO free_ask_conversations (user_id, student_id, title)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, studentId || null, makeFreeAskTitle(question, files)]
    )
  ).rows[0];
}

async function insertFreeAskMessage({ conversationId, userId, role, content, attachments = [], meta = {} }) {
  const message = (
    await query(
      `INSERT INTO free_ask_messages (conversation_id, user_id, role, content, attachments, meta)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [conversationId, userId, role, content || "", JSON.stringify(attachments || []), JSON.stringify(meta || {})]
    )
  ).rows[0];
  await query(
    `UPDATE free_ask_conversations
     SET message_count = (
       SELECT COUNT(*) FROM free_ask_messages WHERE conversation_id = $1
     ),
     last_message_at = now(),
     updated_at = now()
     WHERE id = $1`,
    [conversationId]
  );
  return message;
}

function clipFreeAskText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

async function buildFreeAskConversationContext(conversationId) {
  if (!conversationId) return "";
  const conversation = (await query("SELECT * FROM free_ask_conversations WHERE id = $1", [conversationId])).rows[0];
  if (!conversation) return "";
  const messages = (
    await query(
      `SELECT role, content, created_at
       FROM free_ask_messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [conversationId, freeAskMemoryLimits.recentMessages]
    )
  ).rows.reverse();
  const recent = messages
    .map((message) => `${message.role === "user" ? "用户" : "AI"}：${clipFreeAskText(message.content, 900)}`)
    .join("\n");
  return [
    conversation.memory_summary ? `历史压缩记忆：\n${conversation.memory_summary}` : "",
    recent ? `最近对话：\n${recent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, freeAskMemoryLimits.maxContextChars);
}

function compactFreeAskMemoryText(existingSummary = "", oldMessages = []) {
  const lines = oldMessages
    .map((message) => `${message.role === "user" ? "用户" : "AI"}：${clipFreeAskText(message.content, 240)}`)
    .filter(Boolean);
  const combined = [existingSummary, lines.join("\n")].filter(Boolean).join("\n");
  if (!combined) return "";
  return combined.slice(Math.max(0, combined.length - freeAskMemoryLimits.maxSummaryChars));
}

async function pruneFreeAskConversationMemory(conversationId) {
  const count = Number((await query("SELECT COUNT(*) AS count FROM free_ask_messages WHERE conversation_id = $1", [conversationId])).rows[0]?.count || 0);
  if (count <= freeAskMemoryLimits.maxStoredMessages) return;
  const rows = (
    await query(
      `SELECT id, role, content, created_at
       FROM free_ask_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId]
    )
  ).rows;
  const keepCount = Math.max(8, freeAskMemoryLimits.summarizeKeepMessages);
  const oldMessages = rows.slice(0, Math.max(0, rows.length - keepCount));
  const keepMessages = rows.slice(-keepCount);
  const conversation = (await query("SELECT memory_summary FROM free_ask_conversations WHERE id = $1", [conversationId])).rows[0];
  const nextSummary = compactFreeAskMemoryText(conversation?.memory_summary || "", oldMessages);
  if (oldMessages.length) {
    await query("DELETE FROM free_ask_messages WHERE id = ANY($1::uuid[])", [oldMessages.map((message) => message.id)]);
  }
  await query(
    `UPDATE free_ask_conversations
     SET memory_summary = $2,
         message_count = $3,
         updated_at = now()
     WHERE id = $1`,
    [conversationId, nextSummary, keepMessages.length]
  );
}

function detectFreeAskIntent({ question = "", files = [], wantsImage = false }) {
  if (wantsImage) return "image_generation";
  const incomingFiles = Array.isArray(files) ? files : [];
  const text = String(question || "").replace(/\s+/g, " ").trim();
  const hasFiles = incomingFiles.length > 0;
  const hasImages = incomingFiles.some((file) => isImageUpload(file));
  if (!hasFiles) return "general_chat";

  const explicitQuestionRequest =
    /这道题|这题|本题|题目|题干|解题|讲题|讲解.*题|解析.*题|题怎么|怎么解|怎么做|求解|证明题|计算题|应用题|选择题|填空题|答案|解答|步骤|错题|作业题|试题|试卷|卷子|数学题|物理题|化学题|几何题|函数题|看不懂.*题|不会做|帮我解|帮我做题|分析.*(题|作业|试卷|卷子|错题)/.test(text);
  if (explicitQuestionRequest) return "question_explanation";

  if (hasImages) return "image_understanding";
  return "document_summary";
}

function looksLikeFreeAskQuestionExplanation({ question = "", files = [] }) {
  return detectFreeAskIntent({ question, files, wantsImage: false }) === "question_explanation";
}

function inferFreeAskSubject(question = "", files = []) {
  const text = `${question} ${(files || []).map((file) => file.originalname || "").join(" ")}`;
  if (/物理|力学|电路|压强|浮力|速度|功率/.test(text)) return "物理";
  if (/化学|方程式|溶液|酸|碱|盐|元素|分子|原子/.test(text)) return "化学";
  if (/英语|English|语法|单词|作文/.test(text)) return "英语";
  if (/语文|阅读|文言文|作文|古诗/.test(text)) return "语文";
  return "数学";
}

function buildFreeAskCleanAnswer({ question, materialContext, conversationContext, intent = "general_chat" }) {
  const intentInstruction = {
    image_understanding:
      "本轮任务是图片理解或截图解读。请先根据用户的问题判断他想知道什么，再回答图片内容。除非用户明确要求讲题、解题、作业或试卷分析，不要把图片当成题目，不要输出“题干、已知条件、解题目标、AI讲解”等题目模板。如果是界面截图，请说明它大概是什么页面、主要文字、核心用途和用户需要注意的地方。",
    document_summary:
      "本轮任务是文档或文件内容理解。请按用户要求总结、提取重点、解释含义或指出需要注意的地方，不要套用题目讲解模板。",
    general_chat:
      "本轮任务是普通自由对话。请直接回答用户问题；如果用户没有明确目标，可以温和说明你能如何继续帮他。",
  }[intent] || "";
  return [
    freeAskSystemPrompt,
    conversationContext ? `可参考的历史上下文：\n${conversationContext}` : "",
    intentInstruction,
    "请直接回答用户本轮问题。输出要干净、分段清楚，不要输出原始 LaTeX 代码、JSON 或英文内部字段名。",
    "用户本轮问题：" + (question || "请根据附件回答。"),
    "附件：" + materialContext.fileSummary,
    materialContext.materialText ? "附件可读内容：\n" + materialContext.materialText : "",
  ].filter(Boolean).join("\n\n");
}

async function generateFreeAskQuestionExplanation({ question, files, student, materialContext, onUsage = null }) {
  const subject = inferFreeAskSubject(question, files);
  const grade = student?.grade || "";
  const title = makeFreeAskTitle(question, files);
  const recognitionResult = await generateMistakeGeminiTextWithRetry({
    stage: "free-ask-recognition",
    prompt: buildMistakeRecognitionPrompt({
      subject,
      grade,
      title,
      prompt: question,
      documentText: materialContext.materialText,
    }),
    files: materialContext.safeImageFiles,
    temperature: 0,
    topP: 0.1,
    maxOutputTokens: 2048,
    onUsage,
  });
  const explanationResult = await generateMistakeGeminiTextWithRetry({
    stage: "free-ask-explanation",
    prompt: buildMistakeExplanationPrompt({
      subject,
      grade,
      title,
      prompt: question,
      recognitionText: recognitionResult.text,
      questionScope: "auto",
    }),
    files: [],
    temperature: 0,
    topP: 0.1,
    maxOutputTokens: 4096,
    onUsage,
  });
  const answer = [
    "AI识别到的题目",
    recognitionResult.text,
    "",
    "AI讲解",
    explanationResult.text,
  ].join("\n\n");
  return {
    answer: normalizeStudentMathText(answer),
    provider: "gemini",
    mode: "thinking",
    model: explanationResult.model,
    meta: {
      usedQuestionWorkflow: true,
      recognitionModel: recognitionResult.model,
      explanationModel: explanationResult.model,
      subject,
      grade,
    },
  };
}

async function getFreeAskConversationWithMessages(userId, conversationId) {
  const conversation = (
    await query("SELECT * FROM free_ask_conversations WHERE id = $1 AND user_id = $2 AND is_archived = false", [
      conversationId,
      userId,
    ])
  ).rows[0];
  if (!conversation) return null;
  const messages = (
    await query(
      `SELECT * FROM free_ask_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 120`,
      [conversationId]
    )
  ).rows;
  return {
    conversation: toPublicFreeAskConversation(conversation),
    messages: messages.map(toPublicFreeAskMessage),
  };
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
      [student.id, req.user.id, status === "submitted" ? "提交学情问卷" : "保存学情问卷草稿", JSON.stringify({ questionnaireId: record.id, completion, answers })]
    );
    return record;
  });
  res.json({ saved });
});

app.get("/api/archive/questionnaires", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT id, answers, completion, status, created_at, updated_at
         FROM student_intake_questionnaires
         WHERE student_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({
      records: rows.map((row) => ({
        id: row.id,
        answers: row.answers || {},
        completion: row.completion,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/archive/questionnaires/:id", requireAuth, async (req, res, next) => {
  try {
    const deleted = await withTransaction(async (client) => {
      const record = (
        await client.query(
          `SELECT *
           FROM student_intake_questionnaires
           WHERE id = $1 AND user_id = $2`,
          [req.params.id, req.user.id]
        )
      ).rows[0];
      if (!record) return null;
      await client.query(
        `DELETE FROM student_intake_questionnaires
         WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      await client.query(
        `DELETE FROM student_archive_events
         WHERE student_id = $1
           AND user_id = $2
           AND event_type = 'questionnaire'
           AND (
             payload->>'questionnaireId' = $3
             OR payload @> $4::jsonb
           )`,
        [
          record.student_id,
          req.user.id,
          String(record.id),
          JSON.stringify({
            completion: record.completion,
            answers: record.answers || {},
          }),
        ]
      );
      return record;
    });
    if (!deleted) return res.status(404).json({ error: "QUESTIONNAIRE_NOT_FOUND" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive/statements", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT id, subject, scene, intensity, content, guided_answers, created_at
         FROM student_statements
         WHERE student_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT 100`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({
      records: rows.map((row) => ({
        id: row.id,
        type: "文字陈述",
        title: `${row.subject || "学习"} · ${row.scene || "未选场景"}`,
        content: row.content,
        time: row.created_at,
        subject: row.subject || "",
        scene: row.scene || "",
        intensity: row.intensity,
        tags: [row.subject, row.scene, "文字陈述"].filter(Boolean),
        guidedAnswers: row.guided_answers || {},
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
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
      [student.id, req.user.id, `${subject || "学习"}陈述`, JSON.stringify({ statementId: record.id, subject, scene, intensity, content, guidedAnswers })]
    );
    return record;
  });
  res.json({ saved });
});

app.delete("/api/archive/statements/:id", requireAuth, async (req, res, next) => {
  try {
    const deleted = await withTransaction(async (client) => {
      const record = (
        await client.query(
          `SELECT *
           FROM student_statements
           WHERE id = $1 AND user_id = $2`,
          [req.params.id, req.user.id]
        )
      ).rows[0];
      if (!record) return null;
      await client.query(
        `DELETE FROM student_statements
         WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      await client.query(
        `DELETE FROM student_archive_events
         WHERE student_id = $1
           AND user_id = $2
           AND event_type = 'statement'
           AND (
             payload->>'statementId' = $3
             OR payload @> $4::jsonb
           )`,
        [
          record.student_id,
          req.user.id,
          String(record.id),
          JSON.stringify({
            subject: record.subject,
            scene: record.scene,
            intensity: record.intensity,
            content: record.content,
            guidedAnswers: record.guided_answers || {},
          }),
        ]
      );
      return record;
    });
    if (!deleted) return res.status(404).json({ error: "STATEMENT_NOT_FOUND" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive/learning-profiles", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT id, report, version, created_at
         FROM student_learning_profiles
         WHERE student_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({
      records: rows.map((row) => ({
        id: row.id,
        title: row.report?.profile?.summary || row.report?.profile?.core || "AI学情画像",
        report: row.report || {},
        version: row.version,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive/strategy-suggestions", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT id, title, payload, created_at
         FROM student_archive_events
         WHERE student_id = $1 AND user_id = $2 AND event_type = 'subject_strategy_ai'
         ORDER BY created_at DESC
         LIMIT 50`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({
      records: rows.map((row) => ({
        id: row.id,
        title: row.title || "AI学习任务建议",
        subject: row.payload?.subject || "",
        result: row.payload?.result || {},
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive/profile-self", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const row = (
      await query(
        `SELECT id, payload, created_at
         FROM student_archive_events
         WHERE student_id = $1 AND user_id = $2 AND event_type = 'profile_self_portrait'
         ORDER BY created_at DESC
         LIMIT 1`,
        [student.id, req.user.id]
      )
    ).rows[0];
    res.json({
      record: row
        ? {
            id: row.id,
            selfPortrait: row.payload?.selfPortrait || "",
            selfAssessment: row.payload?.selfAssessment || {},
            createdAt: row.created_at,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/archive/profile-self", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { selfPortrait = "", selfAssessment = {} } = req.body || {};
    if (!String(selfPortrait).trim() && !Object.keys(selfAssessment || {}).length) {
      return res.status(400).json({ error: "PROFILE_SELF_EMPTY", message: "请先填写学生自我画像。" });
    }
    const row = (
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'profile_self_portrait', '学生自我画像', $3)
         RETURNING id, payload, created_at`,
        [student.id, req.user.id, JSON.stringify({ selfPortrait, selfAssessment })]
      )
    ).rows[0];
    res.json({ saved: { id: row.id, createdAt: row.created_at } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/archive/strategy-note", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { subject = "", note = "" } = req.body || {};
    if (!String(note).trim()) return res.status(400).json({ error: "STRATEGY_NOTE_EMPTY", message: "请先填写学习任务补充说明。" });
    const row = (
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'student_strategy_note', $3, $4)
         RETURNING id, payload, created_at`,
        [student.id, req.user.id, `${subject || "学科"}学习任务补充说明`, JSON.stringify({ subject, note })]
      )
    ).rows[0];
    res.json({ saved: { id: row.id, createdAt: row.created_at } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/archive/strategy-task", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { subject = "", task = {} } = req.body || {};
    if (!String(task.title || "").trim()) return res.status(400).json({ error: "STRATEGY_TASK_EMPTY", message: "请先填写任务标题。" });
    const row = (
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'student_strategy_task', $3, $4)
         RETURNING id, payload, created_at`,
        [student.id, req.user.id, `${subject || "学科"}学习任务：${task.title}`, JSON.stringify({ subject, task })]
      )
    ).rows[0];
    res.json({ saved: { id: row.id, createdAt: row.created_at } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive/weekly-learning", requireAuth, async (req, res, next) => {
  try {
    const student = await getPrimaryStudent(req.user);
    const rows = (
      await query(
        `SELECT id, event_type, title, payload, created_at
         FROM student_archive_events
         WHERE student_id = $1
           AND user_id = $2
           AND event_type IN ('weekly_plan_archive', 'weekly_reflection_archive')
         ORDER BY created_at DESC
         LIMIT 80`,
        [student.id, req.user.id]
      )
    ).rows;
    res.json({
      records: rows.map((row) => ({
        id: row.id,
        type: row.event_type,
        title: row.title || "",
        payload: row.payload || {},
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/archive/weekly-plan", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { planRows = [], planNote = "", methodFocusRows = [], habitFocusRows = [] } = req.body || {};
    if (!Array.isArray(planRows) || !planRows.length) {
      return res.status(400).json({ error: "WEEKLY_PLAN_EMPTY", message: "请先填写本周学习计划。" });
    }
    const row = (
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'weekly_plan_archive', '本周学习计划档案', $3)
         RETURNING id, payload, created_at`,
        [student.id, req.user.id, JSON.stringify({ planRows, planNote, methodFocusRows, habitFocusRows })]
      )
    ).rows[0];
    res.json({ saved: { id: row.id, createdAt: row.created_at } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/archive/weekly-reflection", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { dailyReflectionDraft = {}, weeklyDiscussionDraft = {}, dailyReflectionArchive = [], weeklyDiscussionArchive = {} } = req.body || {};
    const hasDaily = Array.isArray(dailyReflectionArchive) && dailyReflectionArchive.length > 0;
    const hasWeekly =
      Array.isArray(weeklyDiscussionArchive?.stateScores) && weeklyDiscussionArchive.stateScores.length > 0
      || Array.isArray(weeklyDiscussionArchive?.discussions) && weeklyDiscussionArchive.discussions.length > 0
      || Array.isArray(weeklyDiscussionArchive?.problems) && weeklyDiscussionArchive.problems.length > 0;
    if (!hasDaily && !hasWeekly) {
      return res.status(400).json({ error: "WEEKLY_REFLECTION_EMPTY", message: "请先填写本周反思或讨论内容。" });
    }
    const row = (
      await query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'weekly_reflection_archive', '本周反思与讨论档案', $3)
         RETURNING id, payload, created_at`,
        [student.id, req.user.id, JSON.stringify({ dailyReflectionDraft, weeklyDiscussionDraft, dailyReflectionArchive, weeklyDiscussionArchive })]
      )
    ).rows[0];
    res.json({ saved: { id: row.id, createdAt: row.created_at } });
  } catch (error) {
    next(error);
  }
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

app.get("/api/forum/files/:id", async (req, res, next) => {
  try {
    const file = (
      await query(
        `SELECT f.*
         FROM uploaded_files f
         WHERE f.id = $1
           AND f.purpose = 'forum_post'
           AND EXISTS (SELECT 1 FROM forum_posts p WHERE f.id = ANY(p.file_ids))`,
        [req.params.id]
      )
    ).rows[0];
    if (!file || !fs.existsSync(file.path)) return res.status(404).json({ error: "FILE_NOT_FOUND" });
    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(path.resolve(file.path));
  } catch (error) {
    next(error);
  }
});

app.get("/api/forum/posts", async (req, res, next) => {
  try {
    const viewer = await getOptionalForumViewer(req);
    const posts = (
      await query(
        `SELECT p.*, u.identifier, u.display_name
         FROM forum_posts p
         JOIN users u ON u.id = p.user_id
         ORDER BY p.is_pinned DESC, p.pinned_at DESC NULLS LAST, p.last_activity_at DESC, p.created_at DESC
         LIMIT 100`
      )
    ).rows;
    if (!posts.length) return res.json({ posts: [] });
    const postIds = posts.map((post) => post.id);
    const replies = (
      await query(
        `SELECT r.*, u.identifier, u.display_name
         FROM forum_replies r
         JOIN users u ON u.id = r.user_id
         WHERE r.post_id = ANY($1::uuid[])
         ORDER BY r.created_at ASC`,
        [postIds]
      )
    ).rows;
    const fileIds = posts.flatMap((post) => post.file_ids || []);
    const files = fileIds.length
      ? (
          await query("SELECT * FROM uploaded_files WHERE id = ANY($1::uuid[]) AND purpose = 'forum_post'", [fileIds])
        ).rows
      : [];
    const repliesByPost = new Map();
    for (const reply of replies) {
      const item = {
        id: reply.id,
        author: reply.display_name || reply.identifier || "会员同学",
        role: reply.role || "member",
        time: formatForumTime(reply.created_at),
        content: reply.content,
        createdAt: reply.created_at,
      };
      repliesByPost.set(reply.post_id, [...(repliesByPost.get(reply.post_id) || []), item]);
    }
    const filesById = new Map(files.map((file) => [file.id, file]));
    res.json({
      posts: posts.map((post) =>
        toForumPost(
          post,
          repliesByPost.get(post.id) || [],
          (post.file_ids || []).map((id) => filesById.get(id)).filter(Boolean),
          viewer?.id || ""
        )
      ),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/forum/posts", requireAuth, upload.array("images", 6), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const { type = "学习问题", title = "", content = "" } = req.body || {};
    if (!title.trim() || !content.trim()) return res.status(400).json({ error: "POST_REQUIRED", message: "请填写标题和内容。" });
    const student = await getPrimaryStudent(req.user);
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "forum_post", req.files || []);
      const post = (
        await client.query(
          `INSERT INTO forum_posts (student_id, user_id, post_type, title, content, file_ids)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, type, title.trim(), content.trim(), fileRows.map((file) => file.id)]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'forum_post', $3, $4)`,
        [student.id, req.user.id, title.trim(), JSON.stringify({ type, content, fileIds: fileRows.map((file) => file.id) })]
      );
      return { post, fileRows };
    });
    res.json({
      post: toForumPost(
        { ...saved.post, identifier: req.user.identifier, display_name: req.user.display_name },
        [],
        saved.fileRows,
        req.user.id
      ),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/forum/posts/:id/replies", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const { content = "" } = req.body || {};
    if (!content.trim()) return res.status(400).json({ error: "REPLY_REQUIRED", message: "请填写留言内容。" });
    const post = (await query("SELECT id FROM forum_posts WHERE id = $1", [req.params.id])).rows[0];
    if (!post) return res.status(404).json({ error: "POST_NOT_FOUND", message: "帖子不存在。" });
    const role = req.user.role === "admin" || req.user.role === "teacher" ? "moderator" : "member";
    const reply = await withTransaction(async (client) => {
      const created = (
        await client.query(
          `INSERT INTO forum_replies (post_id, user_id, role, content)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [req.params.id, req.user.id, role, content.trim()]
        )
      ).rows[0];
      await client.query("UPDATE forum_posts SET last_activity_at = $2, updated_at = $2 WHERE id = $1", [
        req.params.id,
        created.created_at,
      ]);
      return created;
    });
    res.json({
      reply: {
        id: reply.id,
        author: req.user.display_name || req.user.identifier || "会员同学",
        role: reply.role,
        time: formatForumTime(reply.created_at),
        content: reply.content,
        createdAt: reply.created_at,
      },
      lastActivityAt: reply.created_at,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/forum/posts/:id", requireAuth, async (req, res, next) => {
  try {
    const post = (await query("SELECT id, user_id FROM forum_posts WHERE id = $1", [req.params.id])).rows[0];
    if (!post) return res.status(404).json({ error: "POST_NOT_FOUND", message: "帖子不存在。" });
    if (post.user_id !== req.user.id) {
      return res.status(403).json({ error: "POST_DELETE_FORBIDDEN", message: "只能删除自己发布的帖子。" });
    }
    await query("DELETE FROM forum_posts WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/forum/posts/:id/pin", requireAdminToken, async (req, res, next) => {
  try {
    const { pinned = true } = req.body || {};
    const post = (
      await query(
        `UPDATE forum_posts
         SET is_pinned = $2,
             pinned_at = CASE WHEN $2 THEN now() ELSE NULL END,
             pinned_by = CASE WHEN $2 THEN 'admin' ELSE NULL END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [req.params.id, Boolean(pinned)]
      )
    ).rows[0];
    if (!post) return res.status(404).json({ error: "POST_NOT_FOUND", message: "帖子不存在。" });
    res.json({ ok: true, post });
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

app.post("/api/ai/transcribe", requireAuth, (_req, res) => {
  res.status(410).json({
    error: "FEATURE_DISABLED",
    message: "语音陈述功能已关闭，请使用文字方式填写学情陈述。",
  });
});

app.post("/api/ai/transcribe", requireAuth, upload.single("audio"), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 6);
    if (!req.file) return res.status(400).json({ error: "AUDIO_REQUIRED", message: "请上传音频文件。" });
    const student = await getPrimaryStudent(req.user);
    const saved = await withTransaction(async (client) => {
      const files = await saveUploadedFiles(client, req.user, student, "statement_audio", [req.file]);
      const row = (
        await client.query(
          `INSERT INTO statement_audio_files (student_id, user_id, file_id, transcript)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [student.id, req.user.id, files[0]?.id || null, ""]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'audio_transcript', '语音陈述转写', $3)`,
        [student.id, req.user.id, JSON.stringify({ status: "saved", audioId: row.id, fileId: files[0]?.id || null })]
      );
      return row;
    });
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "transcribe",
      provider: "openai",
      mode: "audio-background",
      tokenCost: 6,
      input: { audioId: saved.id, fileId: saved.file_id },
      activeWindowMinutes: 10,
      reuseActive: false,
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 6);
        const filePath = (
          await query("SELECT path FROM uploaded_files WHERE id = $1 AND user_id = $2", [saved.file_id, req.user.id])
        ).rows[0]?.path;
        const transcript = await openai.audio.transcriptions.create({
          file: fs.createReadStream(filePath || req.file.path),
          model: transcriptionModel,
        });
        const text = transcript.text || "";
        await query("UPDATE statement_audio_files SET transcript = $2 WHERE id = $1", [saved.id, text]);
        await query(
          `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
           VALUES ($1, $2, 'audio_transcript_done', '语音陈述转写完成', $3)`,
          [student.id, req.user.id, JSON.stringify({ transcript: text, audioId: saved.id })]
        );
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI transcribe",
          fallbackTokenCost: 6,
          meta: { feature: "transcribe", audioId: saved.id, model: transcriptionModel },
        });
        return { transcript: text, saved, transcribeError: "" };
      });
    }
    res.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

async function resolveSelectedRow({ studentId, userId, id, latestSql, idSql }) {
  const useLatest = !id || id === "latest";
  const sql = useLatest ? latestSql : idSql;
  const params = useLatest ? [studentId, userId] : [studentId, userId, id];
  return (await query(sql, params)).rows[0] || null;
}

function sourceMeta(label, row) {
  if (!row) return { label, id: "", createdAt: "", note: "未选择或暂无档案" };
  return { label, id: row.id, createdAt: row.created_at || row.createdAt || "", note: `${label}：${row.created_at || row.createdAt || ""}` };
}

async function buildArchiveSnapshotFromSourceIds({ feature, student, userId, sourceIds = {}, fallback = {}, subject = "" }) {
  if (!sourceIds || !Object.keys(sourceIds).length) return fallback;
  const questionnaire = await resolveSelectedRow({
    studentId: student.id,
    userId,
    id: sourceIds.questionnaireId,
    latestSql:
      "SELECT id, answers, completion, status, created_at FROM student_intake_questionnaires WHERE student_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1",
    idSql:
      "SELECT id, answers, completion, status, created_at FROM student_intake_questionnaires WHERE student_id = $1 AND user_id = $2 AND id = $3 LIMIT 1",
  });
  const statement = await resolveSelectedRow({
    studentId: student.id,
    userId,
    id: sourceIds.statementId,
    latestSql:
      "SELECT id, subject, scene, content, guided_answers, created_at FROM student_statements WHERE student_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1",
    idSql:
      "SELECT id, subject, scene, content, guided_answers, created_at FROM student_statements WHERE student_id = $1 AND user_id = $2 AND id = $3 LIMIT 1",
  });
  let profile = null;
  if (feature === "strategy") {
    profile = await resolveSelectedRow({
      studentId: student.id,
      userId,
      id: sourceIds.profileId,
      latestSql:
        "SELECT id, report, created_at FROM student_learning_profiles WHERE student_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1",
      idSql:
        "SELECT id, report, created_at FROM student_learning_profiles WHERE student_id = $1 AND user_id = $2 AND id = $3 LIMIT 1",
    });
  }
  let strategy = null;
  if (feature === "study-plan") {
    strategy = await resolveSelectedRow({
      studentId: student.id,
      userId,
      id: sourceIds.strategyId,
      latestSql:
        "SELECT id, title, payload, created_at FROM student_archive_events WHERE student_id = $1 AND user_id = $2 AND event_type = 'subject_strategy_ai' ORDER BY created_at DESC LIMIT 1",
      idSql:
        "SELECT id, title, payload, created_at FROM student_archive_events WHERE student_id = $1 AND user_id = $2 AND event_type = 'subject_strategy_ai' AND id = $3 LIMIT 1",
    });
  }
  const profileSelf = (
    await query(
      `SELECT id, payload, created_at
       FROM student_archive_events
       WHERE student_id = $1 AND user_id = $2 AND event_type = 'profile_self_portrait'
       ORDER BY created_at DESC
       LIMIT 1`,
      [student.id, userId]
    )
  ).rows[0] || null;
  const studentStrategyNote = (
    await query(
      `SELECT id, payload, created_at
       FROM student_archive_events
       WHERE student_id = $1 AND user_id = $2 AND event_type = 'student_strategy_note'
       ORDER BY created_at DESC
       LIMIT 1`,
      [student.id, userId]
    )
  ).rows[0] || null;
  const studentStrategyTasks = (
    await query(
      `SELECT id, payload, created_at
       FROM student_archive_events
       WHERE student_id = $1 AND user_id = $2 AND event_type = 'student_strategy_task'
       ORDER BY created_at DESC
       LIMIT 20`,
      [student.id, userId]
    )
  ).rows;
  const answers = questionnaire?.answers || fallback.questionnaire || {};
  const selectedStatement = statement
    ? [
        {
          id: statement.id,
          type: "文字陈述",
          title: `${statement.subject || "学习"} · ${statement.scene || "未选场景"}`,
          subject: statement.subject || "",
          scene: statement.scene || "",
          content: statement.content,
          guidedAnswers: statement.guided_answers || {},
          time: statement.created_at,
        },
      ]
    : [];
  const selectedSources = {
    questionnaire: sourceMeta("学情问卷", questionnaire),
    statement: sourceMeta("学情陈述", statement),
    profileSelf: sourceMeta("学生自我画像", profileSelf),
    studentStrategyNote: sourceMeta("学生任务补充说明", studentStrategyNote),
    studentStrategyTasks: studentStrategyTasks.map((row) => sourceMeta("学生保存任务", row)),
  };
  if (feature === "strategy") {
    selectedSources.profile = sourceMeta("学情画像", profile);
  }
  if (feature === "study-plan") {
    selectedSources.strategy = sourceMeta("学习任务建议", strategy);
  }
  const studentBase = {
    name: answers?.name || student.name || "",
    grade: answers?.grade || student.grade || "",
    weakSubjects: answers?.weakSubjects || [],
    coreProblemText: answers?.coreProblemText || "",
  };
  if (feature === "profile") {
    return {
      policy: {
        include: ["学情问卷", "学情陈述"],
        exclude: ["每日反思", "每周讨论", "学生自我画像", "错题专项", "知识笔记", "学习日历", "学习资料库", "学习社区", "AI自由问"],
      },
      sourceMode: "selected_archive_ids",
      selectedSources,
      student: studentBase,
      questionnaire: answers,
      questionnaireMeta: selectedSources.questionnaire,
      statements: selectedStatement,
      statementMeta: selectedSources.statement,
      sourcePriority: ["学情陈述等学生原始表达", "学情问卷"],
    };
  }
  if (feature === "strategy") {
    return {
      policy: {
        basis: "优先使用学生原始表达，再结合问卷、学生自我画像和学情画像，为当前科目设计学习任务。",
      },
      sourceMode: "selected_archive_ids",
      selectedSources,
      sourcePriority: ["学情陈述等学生原始表达", "学情问卷", "学生自我画像", "学情画像AI结果"],
      student: studentBase,
      subject: subject || fallback.subject || "",
      profile: profile?.report?.profile || profile?.report || fallback.profile || null,
      profileMeta: selectedSources.profile,
      studentSelfPortrait: profileSelf?.payload || null,
      questionnaireSummary: {
        weakSubjects: answers?.weakSubjects || [],
        coreProblemText: answers?.coreProblemText || "",
      },
      questionnaireMeta: selectedSources.questionnaire,
      recentStatements: selectedStatement,
      statementMeta: selectedSources.statement,
    };
  }
  if (feature === "study-plan") {
    return {
      policy: {
        basis: "根据学情问卷、学情陈述、已保存学习任务、AI学习任务建议、默认可用时间规则和方法习惯目标制定计划。",
        excluded: ["学情画像结果", "每日反思", "每周讨论", "错题图片分析", "知识图生成", "学习社区内容", "资料库文件内容"],
      },
      sourceMode: "selected_archive_ids",
      selectedSources,
      sourcePriority: ["学情陈述等学生原始表达", "学情问卷", "学生保存的学习任务", "AI学习任务建议"],
      student: studentBase,
      questionnaireSummary: {
        weakSubjects: answers?.weakSubjects || [],
        coreProblemText: answers?.coreProblemText || "",
      },
      questionnaireMeta: selectedSources.questionnaire,
      recentStatements: selectedStatement,
      statementMeta: selectedSources.statement,
      strategies: strategy?.payload?.result || fallback.strategies || null,
      strategyMeta: selectedSources.strategy,
      studentStrategyNote: studentStrategyNote?.payload || null,
      studentStrategyTasks: studentStrategyTasks.map((row) => row.payload?.task).filter(Boolean),
    };
  }
  return fallback;
}

app.post("/api/ai/profile", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 12);
    const student = await getPrimaryStudent(req.user);
    const { archiveSnapshot = {}, sourceIds = {} } = req.body || {};
    const resolvedArchiveSnapshot = await buildArchiveSnapshotFromSourceIds({
      feature: "profile",
      student,
      userId: req.user.id,
      sourceIds,
      fallback: archiveSnapshot,
    });
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "profile",
      provider: "openai",
      mode: "text-background",
      tokenCost: 12,
      input: { archiveSnapshot: resolvedArchiveSnapshot, sourceIds },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 12);
        const response = await openai.responses.create({
          model: textModel,
          background: true,
          input: [
            {
              role: "system",
              content:
                "You are the Shuzi AI learning profile agent. Only integrate the student intake questionnaire and student statements. Do not use daily reflections, weekly discussions, student self portrait, mistake practice, knowledge notes, calendar, library, community, or free-chat content as profile evidence. The questionnaire can be long: first read the core questionnaire and weak-subject sections completely, then organize evidence by learning chain such as class, homework, mistakes, review, exam, motivation, execution, environment, and subject-specific weak points. Student statements have priority when they describe concrete events or feelings. Separate confirmed facts, AI inference, and follow-up questions. Return strict JSON in Chinese.",
            },
            {
              role: "user",
              content: jsonInstruction(
                "{summary, core, reasons:[string], evidence:[string], tags:[string], questions:[string], next, archiveConclusion, scores:{motivation:number, method:number, habit:number, execution:number, subject_strategy:number, emotion:number}}"
              ) +
                "\n分析步骤要求：" +
                "\n1. 先从学情问卷中提取核心事实：基础、课堂、作业、错题、复习、考试、学习环境和薄弱科目。" +
                "\n2. 再阅读学情陈述，找出学生自己反复提到的真实困扰、场景、情绪和已尝试方法。" +
                "\n3. 最后形成画像，必须区分证据和推断；不能引用每日反思、每周讨论、学生自我画像或其他页面资料。" +
                "\n4. evidence 写具体证据，不要写空泛判断；questions 写后续还需要追问的问题。" +
                "\n5. summary、core、next、archiveConclusion 必须是字符串，不能是对象；reasons、evidence、tags、questions 必须是字符串数组，数组元素不能是对象。" +
                "\nStudent profile archive snapshot:\n" + JSON.stringify(resolvedArchiveSnapshot),
            },
          ],
        });
        const completed = await waitForOpenAIBackgroundResponse(response, { jobId: job.id, timeoutMessage: "学情画像AI任务仍未完成，系统已尝试取消以控制费用。" });
        const usageEvents = [createOpenAIUsageEvent(completed, textModel)];
        const profile = parseJsonText(getResponseText(completed), {
          summary: "",
          core: "",
          reasons: [],
          evidence: [],
          tags: [],
          questions: [],
          next: "",
          archiveConclusion: "",
          scores: {},
        });
        const saved = await withTransaction(async (client) => {
          const row = (
            await client.query(
              "INSERT INTO student_learning_profiles (student_id, user_id, report) VALUES ($1, $2, $3) RETURNING *",
              [student.id, req.user.id, JSON.stringify({ profile, sourcePolicy: resolvedArchiveSnapshot?.policy || null, selectedSources: resolvedArchiveSnapshot?.selectedSources || null })]
            )
          ).rows[0];
          await client.query(
            "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'learning_profile_ai', $3, $4)",
            [student.id, req.user.id, "AI learning profile analysis", JSON.stringify({ profile, sourcePolicy: resolvedArchiveSnapshot?.policy || null, selectedSources: resolvedArchiveSnapshot?.selectedSources || null })]
          );
          return row;
        });
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI learning profile analysis",
          usageEvents,
          fallbackTokenCost: 12,
          meta: { feature: "profile", model: textModel, profileId: saved.id },
        });
        return { profile, saved };
      });
    }
    res.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/strategy", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 8);
    const student = await getPrimaryStudent(req.user);
    const { subject = "", archiveSnapshot = {}, sourceIds = {} } = req.body || {};
    const resolvedArchiveSnapshot = await buildArchiveSnapshotFromSourceIds({
      feature: "strategy",
      student,
      userId: req.user.id,
      sourceIds,
      fallback: archiveSnapshot,
      subject,
    });
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "strategy",
      provider: "openai",
      mode: "text-background",
      tokenCost: 8,
      input: { subject, archiveSnapshot: resolvedArchiveSnapshot, sourceIds },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 8);
        const response = await openai.responses.create({
          model: textModel,
          background: true,
          input: [
            {
              role: "system",
              content:
                "你是树子AI的学习任务设计老师，服务中国大陆应试教育场景。你只负责为当前科目生成一组可执行的学习任务建议，不负责周计划、不分析错题图片、不生成资料推荐、不修改单个任务。引用资料有明确优先级：第一优先读学生自己写的原始表达，尤其是学情陈述和任务补充；第二优先读学情问卷；第三才参考学生自我画像和AI学情画像。必须结合这些资料和当前科目，判断学生在预习、上课、作业、错题、复习、巩固、试卷分析、方法训练等学习链条中的薄弱环节。数学、语文、英语、物理、化学等科目要按学科特点设计任务，不能只给一个笼统任务。每个任务必须具体、可执行、可检查，不能写空话，例如“多刷题”“认真复习”。返回严格 JSON，全部使用中文。",
            },
            {
              role: "user",
              content:
                jsonInstruction(
                  "{strategy_suggestion:string, ai_note:string, tasks:[{title:string, problem:string, reason:string, time:string, material:string, detail:string, standard:string}]}"
                ) +
                "\n当前科目：" +
                subject +
                "\n输出要求：" +
                "\n1. tasks 至少 4 项，最多 8 项；如果学情信息明显不足，也要给出基础版任务链。" +
                "\n2. 每个任务要对应一个真实学习环节，例如预习、上课、作业、错题、复习、巩固、试卷分析或方法训练。" +
                "\n3. problem 写这个任务解决什么问题；reason 写为什么学生需要做；time 写建议频率和时长；material 写使用什么资料；detail 写具体执行步骤；standard 写完成后如何检查。" +
                "\n4. strategy_suggestion 用简洁段落概括本学科任务设计思路，不要替代 tasks。" +
                "\n5. 不要生成周计划表，不要生成单个任务，不要让学生自己再去判断怎么做。" +
                "\n学情资料 JSON：\n" +
                JSON.stringify(resolvedArchiveSnapshot),
            },
          ],
        });
        const completed = await waitForOpenAIBackgroundResponse(response, { jobId: job.id, timeoutMessage: "学习任务建议AI任务仍未完成，系统已尝试取消以控制费用。" });
        const usageEvents = [createOpenAIUsageEvent(completed, textModel)];
        const result = parseJsonText(getResponseText(completed), { strategy_suggestion: "", ai_note: "", tasks: [] });
        await query(
          "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'subject_strategy_ai', $3, $4)",
          [student.id, req.user.id, "AI learning task suggestion", JSON.stringify({ subject, result, selectedSources: resolvedArchiveSnapshot?.selectedSources || null })]
        );
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI learning task suggestion",
          usageEvents,
          fallbackTokenCost: 8,
          meta: { feature: "strategy", model: textModel, subject },
        });
        return { result };
      });
    }
    res.status(202).json(publicJob(job));
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
    const { archiveSnapshot = {}, currentPlanRows = [], methodFocusRows = [], habitFocusRows = [], sourceIds = {} } = req.body || {};
    const resolvedArchiveSnapshot = await buildArchiveSnapshotFromSourceIds({
      feature: "study-plan",
      student,
      userId: req.user.id,
      sourceIds,
      fallback: archiveSnapshot,
    });
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "study-plan",
      provider: "openai",
      mode: "text-background",
      tokenCost: 8,
      input: { archiveSnapshot: resolvedArchiveSnapshot, currentPlanRows, methodFocusRows, habitFocusRows, sourceIds },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 8);
        const response = await openai.responses.create({
          model: textModel,
          background: true,
          input: [
            {
              role: "system",
              content:
                "你是树子AI的学习计划制定老师，服务中国大陆中学生应试学习场景。你只负责把学情问卷、学情陈述、已保存学习任务、方法习惯目标和默认可用时间安排成一份可修改的周学习计划。不要引用或复述学情画像结果，不要重新诊断学情，不要分析错题图片，不要生成相似题，不要写长篇报告。计划必须具体、可执行、可检查，并且不能把任务排得过满。返回严格 JSON，全部使用中文。",
            },
            {
              role: "user",
              content:
                jsonInstruction(
                  "{note:string, rows:[{cells:{星期一:{start:string,end:string,task:string,note:string},星期二:{start:string,end:string,task:string,note:string},星期三:{start:string,end:string,task:string,note:string},星期四:{start:string,end:string,task:string,note:string},星期五:{start:string,end:string,task:string,note:string},星期六:{start:string,end:string,task:string,note:string},星期日:{start:string,end:string,task:string,note:string}}}], method_focus_suggestions:string[], habit_focus_suggestions:string[], execution_notes:string[]}"
                ) +
                "\n默认可用时间规则：\n" +
                defaultStudyPlanTimePolicy +
                "\n输出要求：" +
                "\n1. rows 生成 3 到 6 行即可，每行代表一类可执行学习任务，不要把每天排满。" +
                "\n2. start/end 必须使用 HH:mm 格式；平日优先使用 06:40-07:00、19:30-20:20、21:00-22:30 这类时间段；课间任务如果使用，只能是 10 分钟以内的轻任务，并在 note 写明“课间轻量完成”。" +
                "\n3. task 写具体任务，note 写执行方法或检查标准，例如“错题重做后遮答案复述思路”。" +
                "\n4. 必须结合学习任务建议中的科目任务来安排，不要凭空新增与学情无关的大任务。" +
                "\n5. note 必须说明：本计划按默认作息生成，学生可以根据真实放学、晚自习和睡觉时间自行修改。" +
                "\n6. method_focus_suggestions 和 habit_focus_suggestions 只写简短建议，不要写成另一份计划。" +
                "\n学情与任务资料 JSON：\n" +
                JSON.stringify(resolvedArchiveSnapshot) +
                "\n当前周计划草稿：\n" +
                JSON.stringify(currentPlanRows) +
                "\n方法训练草稿：\n" +
                JSON.stringify(methodFocusRows) +
                "\n习惯训练草稿：\n" +
                JSON.stringify(habitFocusRows),
            },
          ],
        });
        const completed = await waitForOpenAIBackgroundResponse(response, { jobId: job.id, timeoutMessage: "学习计划AI任务仍未完成，系统已尝试取消以控制费用。" });
        const usageEvents = [createOpenAIUsageEvent(completed, textModel)];
        const plan = parseJsonText(getResponseText(completed), { rows: [], note: "" });
        await query(
          "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'study_plan_ai', $3, $4)",
          [student.id, req.user.id, "AI study plan", JSON.stringify({ plan, selectedSources: resolvedArchiveSnapshot?.selectedSources || null })]
        );
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI study plan",
          usageEvents,
          fallbackTokenCost: 8,
          meta: { feature: "study-plan", model: textModel },
        });
        return { plan };
      });
    }
    res.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/no-answer", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureGeminiKey();
    const files = req.files || [];
    const student = await getPrimaryStudent(req.user);
    const {
      taskType = "guide",
      prompt = "",
      studentQuestion = "",
      subject = "",
      grade = "",
      title = "没有答案",
      source = "",
      questionScope = "auto",
    } = req.body || {};
    const currentResult = parseMaybeJson(req.body?.currentResult, {});
    const history = parseMaybeJson(req.body?.history, []);
    const tokenCost = 10;
    await assertTokenBalance(req.user.id, tokenCost);
    if (!String(prompt || studentQuestion).trim() && !files.length && !Object.keys(currentResult || {}).length) {
      return res.status(400).json({ error: "PROMPT_OR_FILE_REQUIRED", message: "请先上传题目，或写下要思考的问题。" });
    }
    const jobPayload = {
      taskType,
      prompt,
      studentQuestion,
      subject,
      grade,
      title,
      source,
      questionScope,
      currentResult,
      history,
      fileCount: files.length,
    };
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "no-answer",
      provider: "gemini",
      mode: "guidance",
      tokenCost,
      input: jobPayload,
      dedupeInput: { ...jobPayload, files: makeFileDedupeMeta(files) },
      reuseActive: false,
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, tokenCost);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const documentText = await makeDocumentTextSummary(files);
        const recognitionGeminiModel = process.env.GEMINI_MODEL_MISTAKE_RECOGNITION || getMistakeGeminiModel("fast");
        const guidanceGeminiModel = getMistakeGeminiModel("fast");
        let recognitionText = String(currentResult?.recognitionText || "").trim();
        const modelTrace = [];
        if (!recognitionText) {
          if (files.length) {
            const recognitionResult = await generateMistakeGeminiTextWithRetry({
              model: recognitionGeminiModel,
              stage: "no-answer-recognition",
              prompt: buildMistakeRecognitionPrompt({ subject, grade, title, prompt, documentText }),
              files,
              temperature: 0,
              topP: 0.1,
              responseMimeType: "",
              thinkingBudget: Number(process.env.GEMINI_MISTAKE_RECOGNITION_THINKING_BUDGET || 512),
              maxOutputTokens: Number(process.env.GEMINI_MISTAKE_RECOGNITION_MAX_OUTPUT_TOKENS || 2048),
              onUsage: collectUsage,
            });
            recognitionText = compactRepeatedMistakeText(normalizeStudentMathText(recognitionResult.text));
            modelTrace.push(recognitionResult);
          } else {
            recognitionText = [studentQuestion, prompt, documentText].filter((item) => String(item || "").trim()).join("\n\n");
          }
        }
        const guidancePrompt = buildNoAnswerGuidancePrompt({
          taskType,
          subject,
          grade,
          title,
          prompt,
          studentQuestion,
          recognitionText,
          currentResult,
          history,
          questionScope,
        });
        let guidanceResult = await generateMistakeGeminiTextWithRetry({
          model: guidanceGeminiModel,
          stage: "no-answer-guidance",
          prompt: guidancePrompt,
          files: [],
          temperature: 0.25,
          topP: 0.35,
          responseMimeType: "",
          thinkingBudget: Number(process.env.GEMINI_NO_ANSWER_THINKING_BUDGET || 768),
          maxOutputTokens: Number(process.env.GEMINI_NO_ANSWER_MAX_OUTPUT_TOKENS || 1400),
          onUsage: collectUsage,
        });
        modelTrace.push(guidanceResult);
        let guidance = compactRepeatedMistakeText(normalizeStudentMathText(guidanceResult.text));
        let audit = auditNoAnswerGuidance(guidance);
        if (!audit.ok) {
          const repairResult = await generateMistakeGeminiTextWithRetry({
            model: guidanceGeminiModel,
            stage: "no-answer-repair",
            prompt: buildNoAnswerRepairPrompt({ previousText: guidance, auditProblems: audit.problems, guidancePrompt }),
            files: [],
            temperature: 0.15,
            topP: 0.2,
            responseMimeType: "",
            thinkingBudget: Number(process.env.GEMINI_NO_ANSWER_REPAIR_THINKING_BUDGET || 512),
            maxOutputTokens: Number(process.env.GEMINI_NO_ANSWER_MAX_OUTPUT_TOKENS || 1400),
            onUsage: collectUsage,
          });
          modelTrace.push(repairResult);
          guidanceResult = repairResult;
          guidance = compactRepeatedMistakeText(normalizeStudentMathText(repairResult.text));
          audit = auditNoAnswerGuidance(guidance);
        }
        const result = {
          title: title || "没有答案",
          summary: "AI只会引导观察、拆条件和寻找下一步，不会给最终答案。",
          recognitionText,
          guidance,
          meta: {
            taskType,
            subject,
            grade,
            source,
            questionScope,
            audit,
            modelTrace,
            model: guidanceResult.model,
          },
        };
        const saved = await withTransaction(async (client) => {
          const fileRows = files.length ? await saveUploadedFiles(client, req.user, student, "no_answer", files) : [];
          const row = (
            await client.query(
              `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
               VALUES ($1, $2, 'no_answer_guidance', $3, $4)
               RETURNING *`,
              [student.id, req.user.id, title || "没有答案", JSON.stringify({ taskType, prompt, studentQuestion, subject, grade, result, fileIds: fileRows.map((item) => item.id) })]
            )
          ).rows[0];
          return row;
        });
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "No-answer guidance AI",
          usageEvents,
          fallbackTokenCost: tokenCost,
          meta: {
            feature: "no-answer",
            provider: "gemini",
            model: guidanceResult.model,
            archiveEventId: saved.id,
          },
        });
        return { result, saved };
      });
    }
    res.status(202).json(publicJob(job));
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
      grade = "",
      title = "错题专项处理",
      source = "",
      archiveSnapshot = "{}",
      questionScope = "auto",
    } = req.body || {};
    const normalizedQualityMode = "high";
    const tokenCost = taskType === "generateSimilar" ? 6 : normalizedQualityMode === "high" ? 14 : 8;
    await assertTokenBalance(req.user.id, tokenCost);
    if (!prompt.trim() && !files.length) return res.status(400).json({ error: "PROMPT_OR_FILE_REQUIRED" });
    const taskMap = {
      custom: "学生自定义要求：根据上传材料和学生输入回答。",
      analyzeMistake: "AI分析错题：给学生讲解题目，给出清楚框架和答案。",
      generateSimilar: "AI生成类似题：根据上传或选择的错题生成1-3道解题方法类似、思路结构相近的训练题，包含答案、步骤和训练目的。",
      analyzePaper: "AI分析试卷：根据可见证据整理试卷问题线索、可能原因、确认方式、优先处理顺序和训练建议。",
    };
    const geminiMode = normalizedQualityMode;
    const geminiModel = getMistakeGeminiModel(normalizedQualityMode);
    const recognitionGeminiModel = process.env.GEMINI_MODEL_MISTAKE_RECOGNITION || getMistakeGeminiModel("fast");
    const fallbackGeminiModel = getMistakeGeminiModel("fast");
    const usePlainMistakeText = !["generateSimilar", "analyzePaper"].includes(taskType);
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "mistake-workflow",
      provider: "gemini",
      mode: geminiMode,
      tokenCost,
      input: { taskType, prompt, subject, grade, title, source, archiveSnapshot, questionScope, fileCount: files.length, qualityMode: normalizedQualityMode },
      dedupeInput: {
        taskType,
        prompt,
        subject,
        grade,
        title,
        source,
        archiveSnapshot,
        questionScope,
        qualityMode: normalizedQualityMode,
        files: makeFileDedupeMeta(files),
      },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, tokenCost);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const documentText = await makeDocumentTextSummary(files);
        let recognitionText = "";
        let reportText = "";
        const modelTrace = [];
        let usedFallback = false;
        let finalAudit = null;
        if (usePlainMistakeText) {
          if (files.length) {
            const recognitionResult = await generateMistakeGeminiTextWithRetry({
              model: recognitionGeminiModel,
              stage: "recognition",
              prompt: buildMistakeRecognitionPrompt({ subject, grade, title, prompt, documentText }),
              files,
              temperature: 0,
              topP: 0.1,
              responseMimeType: "",
              thinkingBudget: Number(process.env.GEMINI_MISTAKE_RECOGNITION_THINKING_BUDGET || 512),
              maxOutputTokens: Number(process.env.GEMINI_MISTAKE_RECOGNITION_MAX_OUTPUT_TOKENS || 2048),
              onUsage: collectUsage,
            });
            recognitionText = recognitionResult.text;
            modelTrace.push(recognitionResult);
            usedFallback ||= recognitionResult.usedFallback;
          } else {
            recognitionText = [prompt, documentText].filter((item) => String(item || "").trim()).join("\n\n");
          }
          recognitionText = compactRepeatedMistakeText(normalizeStudentMathText(recognitionText));
          const explanationResult = await generateMistakeGeminiTextWithRetry({
            model: geminiModel,
            stage: "explanation",
            prompt: buildMistakeExplanationPrompt({
              subject,
              grade,
              title,
              prompt,
              recognitionText,
              questionScope,
            }),
            files: [],
            temperature: 0,
            topP: 0.1,
            responseMimeType: "",
            thinkingBudget: Number(process.env.GEMINI_MISTAKE_THINKING_BUDGET || (normalizedQualityMode === "high" ? 2048 : 1024)),
            maxOutputTokens: Number(process.env.GEMINI_MISTAKE_EXPLANATION_MAX_OUTPUT_TOKENS || 4096),
            onUsage: collectUsage,
          });
          reportText = compactRepeatedMistakeText(normalizeStudentMathText(explanationResult.text));
          modelTrace.push(explanationResult);
          let audit = auditMistakeExplanation(reportText, { subject, grade, questionScope });
          if (!audit.ok) {
            const repairResult = await generateMistakeGeminiTextWithRetry({
              model: geminiModel,
              stage: "explanation_repair",
              prompt: buildMistakeRepairPrompt({
                subject,
                grade,
                title,
                prompt,
                recognitionText,
                questionScope,
                previousText: reportText,
                auditProblems: audit.problems,
              }),
              files: [],
              temperature: 0,
              topP: 0.1,
              responseMimeType: "",
              thinkingBudget: Number(process.env.GEMINI_MISTAKE_REPAIR_THINKING_BUDGET || 1024),
              maxOutputTokens: Number(process.env.GEMINI_MISTAKE_EXPLANATION_MAX_OUTPUT_TOKENS || 4096),
              onUsage: collectUsage,
            });
            reportText = compactRepeatedMistakeText(normalizeStudentMathText(repairResult.text));
            modelTrace.push(repairResult);
            audit = auditMistakeExplanation(reportText, { subject, grade, questionScope });
          }
          finalAudit = audit;
          usedFallback ||= false;
        } else {
          const geminiPrompt = buildMistakeWorkflowPrompt({
            taskType,
            taskText: taskMap[taskType] || taskMap.analyzeMistake,
            subject,
            grade,
            title,
            source,
            prompt,
            archiveSnapshot,
            documentText,
            questionScope,
          });
          const structuredResult = await generateMistakeGeminiTextWithFallback({
            model: geminiModel,
            fallbackModel: fallbackGeminiModel,
            stage: taskType,
            prompt: geminiPrompt,
            files,
            temperature: 0,
            topP: 0.1,
            responseMimeType: "application/json",
            thinkingBudget: undefined,
            maxOutputTokens: Number(process.env.GEMINI_MISTAKE_STRUCTURED_MAX_OUTPUT_TOKENS || 4096),
            onUsage: collectUsage,
          });
          reportText = structuredResult.text;
          modelTrace.push(structuredResult);
          usedFallback ||= structuredResult.usedFallback;
        }
        const effectiveGeminiModel = modelTrace.map((item) => `${item.stage}:${item.model}`).join(" | ") || geminiModel;
        const report =
          usePlainMistakeText
            ? normalizeMistakePlainTextReport(reportText, {
                title,
                subject,
                provider: "gemini",
                model: effectiveGeminiModel,
                taskType,
                qualityMode: normalizedQualityMode,
                recognitionText,
                usedFallback,
              })
            : normalizeMistakeWorkflowReport(reportText, {
                title,
                provider: "gemini",
                model: effectiveGeminiModel,
                taskType,
                qualityMode: normalizedQualityMode,
                usedFallback,
              });
        report.meta = { ...(report.meta || {}), usedFallback, modelTrace, audit: finalAudit, questionScope };
        const chargedTokenCost = usedFallback && tokenCost > 8 ? 8 : tokenCost;
        const saved = await withTransaction(async (client) => {
          const fileRows = await saveUploadedFiles(client, req.user, student, "mistake", files);
          const row = (
            await client.query(
              `INSERT INTO mistake_files (student_id, user_id, subject, title, file_ids, analysis)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING *`,
              [student.id, req.user.id, subject, title, fileRows.map((item) => item.id), JSON.stringify({ taskType, prompt, grade, provider: "gemini", model: effectiveGeminiModel, usedFallback, report })]
            )
          ).rows[0];
          await client.query(
            `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
             VALUES ($1, $2, 'mistake_workspace', $3, $4)`,
            [student.id, req.user.id, title, JSON.stringify({ taskType, prompt, grade, provider: "gemini", model: effectiveGeminiModel, usedFallback, report, fileCount: files.length })]
          );
          return row;
        });
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: taskMap[taskType] || "Mistake workflow AI",
          usageEvents,
          fallbackTokenCost: chargedTokenCost,
          meta: {
            feature: "mistake-workflow",
            provider: "gemini",
            model: effectiveGeminiModel,
            mode: geminiMode,
            taskType,
            usedFallback,
            mistakeId: saved.id,
          },
        });
        return { report, saved };
      });
    }
    res.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/mistakes/follow-up", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureGeminiKey();
    await assertTokenBalance(req.user.id, 6);
    const student = await getPrimaryStudent(req.user);
    const {
      question = "",
      report = {},
      history = [],
      subject = "",
      grade = "",
      title = "错题继续追问",
      questionScope = "auto",
    } = req.body || {};
    const cleanQuestion = String(question || "").trim();
    if (!cleanQuestion) return res.status(400).json({ error: "QUESTION_REQUIRED", message: "请先写下要追问的内容。" });
    if (!report || !Object.keys(report).length) return res.status(400).json({ error: "REPORT_REQUIRED", message: "请先完成一次错题分析。" });
    const jobPayload = {
      question: cleanQuestion,
      report,
      history,
      subject,
      grade,
      title,
      questionScope,
    };
    const model = getMistakeGeminiModel("fast");
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "mistake-follow-up",
      provider: "gemini",
      mode: "text-background",
      tokenCost: 6,
      input: jobPayload,
      dedupeInput: jobPayload,
      reuseActive: false,
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 6);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const result = await generateMistakeGeminiTextWithRetry({
          model,
          stage: "mistake-follow-up",
          prompt: buildMistakeFollowUpPrompt(jobPayload),
          files: [],
          temperature: 0.2,
          topP: 0.2,
          responseMimeType: "",
          thinkingBudget: Number(process.env.GEMINI_MISTAKE_FOLLOW_UP_THINKING_BUDGET || 512),
          maxOutputTokens: Number(process.env.GEMINI_MISTAKE_FOLLOW_UP_MAX_OUTPUT_TOKENS || 2048),
          onUsage: collectUsage,
        });
        const answer = normalizeStudentMathText(result.text || "");
        await query(
          `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
           VALUES ($1, $2, 'mistake_follow_up', $3, $4)`,
          [student.id, req.user.id, title || "错题继续追问", JSON.stringify({ question: cleanQuestion, answer, subject, grade, model: result.model })]
        );
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "Mistake follow-up AI",
          usageEvents,
          fallbackTokenCost: 6,
          meta: {
            feature: "mistake-follow-up",
            provider: "gemini",
            model: result.model,
            subject,
            grade,
          },
        });
        return { answer, model: result.model };
      });
    }
    res.status(202).json(publicJob(job));
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
    const mistakeGeminiModel = getMistakeGeminiModel();
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "mistake-analyze",
      provider: "gemini",
      mode: "vision-background",
      tokenCost: 12,
      input: { subject, title, note, fileCount: files.length },
      dedupeInput: { subject, title, note, files: makeFileDedupeMeta(files) },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 12);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
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
        const analysisResult = await generateMistakeGeminiTextWithRetry({
          model: mistakeGeminiModel,
          stage: "legacy-analyze",
          prompt,
          files,
          responseMimeType: "application/json",
          onUsage: collectUsage,
        });
        const analysisText = analysisResult.text;
        const analysis = parseJsonText(analysisText, { mistake_title: title });
        const effectiveModel = analysisResult.model;
        const saved = await withTransaction(async (client) => {
          const fileRows = await saveUploadedFiles(client, req.user, student, "mistake", files);
          const row = (
            await client.query(
              `INSERT INTO mistake_files (student_id, user_id, subject, title, file_ids, analysis)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING *`,
              [student.id, req.user.id, subject, title, fileRows.map((item) => item.id), JSON.stringify({ provider: "gemini", model: effectiveModel, usedFallback: analysisResult.usedFallback, analysis })]
            )
          ).rows[0];
          await client.query(
            `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
             VALUES ($1, $2, 'mistake_analysis', $3, $4)`,
            [student.id, req.user.id, title, JSON.stringify({ provider: "gemini", model: effectiveModel, usedFallback: analysisResult.usedFallback, analysis })]
          );
          return row;
        });
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI mistake recognition",
          usageEvents,
          fallbackTokenCost: 12,
          meta: {
            feature: "mistake-analyze",
            provider: "gemini",
            model: effectiveModel,
            retried: analysisResult.retried,
            mistakeId: saved.id,
          },
        });
        return { analysis, saved };
      });
    }
    res.status(202).json(publicJob(job));
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
    const mistakeGeminiModel = getMistakeGeminiModel();
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "mistake-practice",
      provider: "gemini",
      mode: "text-background",
      tokenCost: 10,
      input: { sourceMistakeId, subject, mistake, count },
      dedupeInput: { sourceMistakeId, subject, mistake, count },
    });
    if (!reused) {
      startAiJob(job.id, async () => {
        await assertTokenBalance(req.user.id, 10);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const prompt = [
          "你是树子AI相似题训练智能体。根据错题的知识点、方法缺口和错误类型，生成1-3道相似题，必须包含答案、步骤和训练目的。必须输出严格JSON。",
          jsonInstruction("{questions:[{title, question, answer, solution_steps, training_goal, difficulty}]}"),
          `科目：${subject}`,
          `数量：${Math.min(3, Math.max(1, Number(count) || 1))}`,
          `错题信息：${JSON.stringify(mistake)}`,
        ].join("\n");
        const generatedResult = await generateMistakeGeminiTextWithFallback({
          model: mistakeGeminiModel,
          fallbackModel: getMistakeGeminiModel("fast"),
          stage: "legacy-practice",
          prompt,
          responseMimeType: "application/json",
          onUsage: collectUsage,
        });
        const generatedText = generatedResult.text;
        const generated = parseJsonText(generatedText, { questions: [] });
        const saved = (
          await query(
            `INSERT INTO generated_practice (student_id, user_id, source_mistake_id, questions)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [student.id, req.user.id, sourceMistakeId, JSON.stringify(generated.questions || generated)]
          )
        ).rows[0];
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI similar practice generation",
          usageEvents,
          fallbackTokenCost: generatedResult.usedFallback ? 6 : 10,
          meta: {
            feature: "mistake-practice",
            provider: "gemini",
            model: generatedResult.model,
            usedFallback: generatedResult.usedFallback,
            practiceId: saved.id,
          },
        });
        return { practice: generated, saved };
      });
    }
    res.status(202).json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/jobs/:jobId", requireAuth, async (req, res, next) => {
  try {
    const job = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE id = $1 AND user_id = $2`,
        [req.params.jobId, req.user.id]
      )
    ).rows[0];
    if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND", message: "没有找到这次AI任务。" });
    res.json(publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/jobs/active/:feature", requireAuth, async (req, res, next) => {
  try {
    const job = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE user_id = $1
           AND feature = $2
           AND status IN ('queued', 'processing')
           AND created_at > now() - interval '30 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [req.user.id, req.params.feature]
      )
    ).rows[0];
    res.json({ job: publicJob(job) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/jobs", requireAuth, async (req, res, next) => {
  try {
    const { status = "", limit = 12 } = req.query || {};
    const params = [req.user.id];
    const statusFilter = String(status || "").trim();
    const where = ["user_id = $1"];
    if (statusFilter) {
      params.push(statusFilter);
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(50, Math.max(1, Number(limit) || 12)));
    const rows = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      )
    ).rows;
    res.json({ jobs: rows.map(publicJob) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/jobs/:jobId/cancel", requireAuth, async (req, res, next) => {
  try {
    const job = (
      await query(
        `SELECT *
         FROM ai_generation_jobs
         WHERE id = $1 AND user_id = $2`,
        [req.params.jobId, req.user.id]
      )
    ).rows[0];
    if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND", message: "没有找到这次AI任务。" });
    if (job.external_response_id && job.provider === "openai") {
      try {
        await openai.responses.cancel(job.external_response_id);
      } catch (error) {
        console.warn("Failed to cancel OpenAI background response", job.external_response_id, error.message);
      }
    }
    const updated = (
      await query(
        `UPDATE ai_generation_jobs
         SET status = 'failed',
             error = $3,
             updated_at = now(),
             completed_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [job.id, req.user.id, JSON.stringify({ message: "AI任务已取消。", detail: "cancelled_by_user" })]
      )
    ).rows[0];
    res.json(publicJob(updated));
  } catch (error) {
    next(error);
  }
});

function buildKnowledgeNotePrompt({ topic = "", grade = "", subject = "", useTemplate = false, template = "", breakdown = null } = {}) {
  const cleanTopic = String(topic || "").trim();
  const templateSource = String(template || "").trim() || knowledgeInfographicTemplate;
  const compactTemplate = templateSource
    .replaceAll("[SUBJECT]", cleanTopic)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("，")
    .slice(0, 500);
  const templatePrompt =
    useTemplate === true || useTemplate === "true"
      ? `\n\n参考版式要求：${compactTemplate}`
      : "";
  const pointsText = Array.isArray(breakdown?.points) && breakdown.points.length
    ? "\n核心知识点：" +
      breakdown.points
        .map((item, index) => `${index + 1}. ${item.name}：${item.desc}${item.tip ? `；学习提醒：${item.tip}` : ""}`)
        .join("；")
    : "";
  const summaryText = breakdown?.summary ? `\n知识总结：${breakdown.summary}` : "";
  return (
    `制作一张中文学习知识图。主题：${breakdown?.title || cleanTopic}。学科：${subject || "不限"}。年级：${grade || "中学生"}。` +
    "要求：白色背景，清楚大标题，中心结构图，5到7个短标签，底部一句学习总结。文字要少而准确，标签内容必须尽量来自下方核心知识点，适合学生复习。不要编造教材事实，不要把中文写成乱码。" +
    summaryText +
    pointsText +
    (breakdown?.imageBrief ? `\n画面说明：${breakdown.imageBrief}` : "") +
    templatePrompt
  );
}

function buildKnowledgeRevisionPrompt({ revision = "", grade = "", subject = "", currentNote = {}, breakdown = null } = {}) {
  const currentTitle = String(currentNote?.title || "当前知识图").trim();
  const currentSubtitle = String(currentNote?.subtitle || "").trim();
  const currentPoints = Array.isArray(currentNote?.points)
    ? currentNote.points
        .map((item, index) => {
          if (Array.isArray(item)) return `${index + 1}. ${item[0] || ""}：${item[1] || ""}`;
          return `${index + 1}. ${item?.name || item?.title || ""}：${item?.desc || ""}${item?.tip ? `；${item.tip}` : ""}`;
        })
        .filter((item) => item.replace(/[\d.：；\s]/g, ""))
        .join("；")
    : "";
  const revisedPoints = Array.isArray(breakdown?.points) && breakdown.points.length
    ? "\n修改后的核心知识点：" +
      breakdown.points
        .map((item, index) => `${index + 1}. ${item.name}：${item.desc}${item.tip ? `；学习提醒：${item.tip}` : ""}`)
        .join("；")
    : "";
  return [
    "制作一张中文学习知识图的修改版。现在不是首次生成，不要套用默认提示词模板；学生的修改意见优先级最高。",
    `上一版主题：${currentTitle}`,
    currentSubtitle ? `上一版说明：${currentSubtitle}` : "",
    currentPoints ? `上一版核心内容：${currentPoints}` : "",
    `学生修改意见：${revision}`,
    `学科：${subject || "不限"}。年级：${grade || "中学生"}。`,
    "要求：保留上一版主题的连续性，但按学生意见重新组织画面、重点和文字。白色背景，清楚大标题，中心结构图，5到7个短标签，底部一句学习总结。文字要少而准确，不要把中文写成乱码。",
    breakdown?.summary ? `\n修改后的知识总结：${breakdown.summary}` : "",
    revisedPoints,
    breakdown?.imageBrief ? `\n画面说明：${breakdown.imageBrief}` : "",
  ].filter(Boolean).join("\n");
}

app.post("/api/ai/knowledge-note", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 35);
    const student = await getPrimaryStudent(req.user);
    const payload = req.body || {};
    const topic = String(payload.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "TOPIC_REQUIRED" });
    const jobPayload = { ...payload, topic };
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "knowledge-note",
      provider: "openai",
      mode: "image-background",
      tokenCost: 35,
      input: jobPayload,
      dedupeInput: jobPayload,
    });
    if (!reused) {
      startAiJob(job.id, async ({ setExternalResponseId }) => {
        ensureOpenAIKey();
        await assertTokenBalance(req.user.id, 35);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const imageQualityForRequest = resolveImageQuality(topic);
        const breakdown = await generateKnowledgeBreakdown({
          topic,
          grade: jobPayload.grade,
          subject: jobPayload.subject,
          promptText: topic,
          onUsage: collectUsage,
        });
        const prompt = buildKnowledgeNotePrompt({ ...jobPayload, breakdown });
        const imageBase64 = await generateOpenAIImageBackground(prompt, setExternalResponseId, imageQualityForRequest);
        if (imageBase64) usageEvents.push(createImageUsageEvent({ quality: imageQualityForRequest }));
        const note = {
          topic,
          title: breakdown.title,
          subtitle: breakdown.subtitle,
          summary: breakdown.summary,
          points: breakdown.points,
          imageBrief: breakdown.imageBrief,
          quality: imageQualityForRequest,
          prompt,
          text: breakdown.summary,
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
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI knowledge image generation",
          usageEvents,
          fallbackTokenCost: 35,
          meta: {
            feature: "knowledge-note",
            provider: "openai",
            noteId: saved.id,
            imageModel,
            imageQuality: imageQualityForRequest,
          },
        });
        return { note, imageBase64, saved, points: breakdown.points, quality: imageQualityForRequest };
      });
    }
    res.status(202).json({ ...publicJob(job), message: reused ? "已有知识图正在后台生成，已继续等待原任务，避免重复扣费。" : "知识图已进入后台生成，请稍候。" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/knowledge-note/revise", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    await assertTokenBalance(req.user.id, 35);
    const student = await getPrimaryStudent(req.user);
    const payload = req.body || {};
    const revision = String(payload.revision || "").trim();
    const currentNote = payload.currentNote || {};
    const currentTitle = String(currentNote.title || "").trim();
    if (!revision) return res.status(400).json({ error: "REVISION_REQUIRED", message: "请先写下要怎样修改当前知识图。" });
    if (!currentTitle && !Array.isArray(currentNote.points)) {
      return res.status(400).json({ error: "CURRENT_NOTE_REQUIRED", message: "请先生成一张知识图，再继续修改。" });
    }
    const jobPayload = {
      revision,
      currentNote: {
        title: currentTitle,
        subtitle: currentNote.subtitle || "",
        points: Array.isArray(currentNote.points) ? currentNote.points : [],
        prompt: currentNote.prompt || "",
      },
      grade: payload.grade || "",
      subject: payload.subject || "",
    };
    const { job, reused } = await createAiJob({
      userId: req.user.id,
      studentId: student.id,
      feature: "knowledge-note-revision",
      provider: "openai",
      mode: "image-background",
      tokenCost: 35,
      input: jobPayload,
      dedupeInput: jobPayload,
    });
    if (!reused) {
      startAiJob(job.id, async ({ setExternalResponseId }) => {
        ensureOpenAIKey();
        await assertTokenBalance(req.user.id, 35);
        const usageEvents = [];
        const collectUsage = (event) => usageEvents.push(event);
        const baseTopic = currentTitle || "知识图";
        const imageQualityForRequest = resolveImageQuality(revision);
        const breakdown = await generateKnowledgeBreakdown({
          topic: baseTopic,
          grade: jobPayload.grade,
          subject: jobPayload.subject,
          promptText: [
            `上一版标题：${baseTopic}`,
            jobPayload.currentNote.subtitle ? `上一版说明：${jobPayload.currentNote.subtitle}` : "",
            `学生修改意见：${revision}`,
          ].filter(Boolean).join("\n"),
          onUsage: collectUsage,
        });
        const prompt = buildKnowledgeRevisionPrompt({ ...jobPayload, breakdown });
        const imageBase64 = await generateOpenAIImageBackground(prompt, setExternalResponseId, imageQualityForRequest);
        if (imageBase64) usageEvents.push(createImageUsageEvent({ quality: imageQualityForRequest }));
        const note = {
          topic: baseTopic,
          title: breakdown.title || baseTopic,
          subtitle: breakdown.subtitle,
          summary: breakdown.summary,
          points: breakdown.points,
          imageBrief: breakdown.imageBrief,
          quality: imageQualityForRequest,
          prompt,
          revision,
          previousTitle: baseTopic,
          text: breakdown.summary,
          imageMimeType: "image/png",
        };
        const saved = (
          await query(
            `INSERT INTO knowledge_notes (student_id, user_id, topic, note, image_base64)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, student_id, user_id, topic, note, created_at`,
            [student.id, req.user.id, `${baseTopic}（修改）`, JSON.stringify(note), imageBase64 || null]
          )
        ).rows[0];
        await recordAiUsageBilling(req.user.id, {
          jobId: job.id,
          note: "AI knowledge image revision",
          usageEvents,
          fallbackTokenCost: 35,
          meta: {
            feature: "knowledge-note-revision",
            provider: "openai",
            noteId: saved.id,
            imageModel,
            imageQuality: imageQualityForRequest,
          },
        });
        return { note, imageBase64, saved, points: breakdown.points, quality: imageQualityForRequest };
      });
    }
    res.status(202).json({ ...publicJob(job), message: reused ? "已有知识图修改任务正在后台生成，已继续等待原任务，避免重复扣费。" : "知识图修改已进入后台生成，请稍候。" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/free-ask/conversations", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const rows = (
      await query(
        `SELECT *
         FROM free_ask_conversations
         WHERE user_id = $1 AND is_archived = false
         ORDER BY last_message_at DESC
         LIMIT 60`,
        [req.user.id]
      )
    ).rows;
    res.json({ conversations: rows.map(toPublicFreeAskConversation) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/free-ask/conversations", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const conversation = await ensureFreeAskConversation({
      userId: req.user.id,
      studentId: student.id,
      conversationId: "",
      question: req.body?.title || "",
      files: [],
    });
    res.status(201).json({ conversation: toPublicFreeAskConversation(conversation), messages: [] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/free-ask/conversations/:conversationId", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const payload = await getFreeAskConversationWithMessages(req.user.id, req.params.conversationId);
    if (!payload) return res.status(404).json({ error: "CONVERSATION_NOT_FOUND" });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/ai/free-ask/conversations/:conversationId", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const { title, archived } = req.body || {};
    const row = (
      await query(
        `UPDATE free_ask_conversations
         SET title = COALESCE($3, title),
             is_archived = COALESCE($4, is_archived),
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [req.params.conversationId, req.user.id, title ? String(title).slice(0, 40) : null, typeof archived === "boolean" ? archived : null]
      )
    ).rows[0];
    if (!row) return res.status(404).json({ error: "CONVERSATION_NOT_FOUND" });
    res.json({ conversation: toPublicFreeAskConversation(row) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/free-ask", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    const student = await getPrimaryStudent(req.user);
    const { question = "", wantsImage = "false", provider = "openai", mode = "fast", conversationId = "" } = req.body || {};
    const files = req.files || [];
    const aiProvider = normalizeAiProvider(provider);
    const aiMode = normalizeAiMode(mode);
    const shouldGenerateImage = wantsImage === "true";
    const freeAskIntent = detectFreeAskIntent({ question, files, wantsImage: shouldGenerateImage });
    const useQuestionWorkflow = freeAskIntent === "question_explanation";
    const tokenCost = shouldGenerateImage ? 35 : useQuestionWorkflow || aiMode === "thinking" ? 8 : 5;
    await assertTokenBalance(req.user.id, tokenCost);
    if (!String(question).trim() && !files.length) {
      return res.status(400).json({ error: "QUESTION_REQUIRED", message: "Please enter a question or upload a file." });
    }
    const conversation = await ensureFreeAskConversation({
      userId: req.user.id,
      studentId: student.id,
      conversationId,
      question,
      files,
    });
    const conversationContext = await buildFreeAskConversationContext(conversation.id);
    const attachmentMeta = makeFreeAskAttachmentMeta(files);
    const userMessage = await insertFreeAskMessage({
      conversationId: conversation.id,
      userId: req.user.id,
      role: "user",
      content: question || (files.length ? `已上传 ${files.length} 个文件，请根据附件回答。` : ""),
      attachments: attachmentMeta,
      meta: { provider: aiProvider, mode: aiMode, wantsImage: shouldGenerateImage, intent: freeAskIntent, useQuestionWorkflow },
    });
    if ((!conversation.title || conversation.title === "新的对话") && makeFreeAskTitle(question, files) !== "新的对话") {
      await query("UPDATE free_ask_conversations SET title = $2, updated_at = now() WHERE id = $1", [
        conversation.id,
        makeFreeAskTitle(question, files),
      ]);
    }
    const materialContext = await buildFreeAskMaterialContext(files);
    const promptText = buildFreeAskCleanAnswer({ question, materialContext, conversationContext, intent: freeAskIntent });

    if (shouldGenerateImage || files.length) {
      const { job, reused } = await createAiJob({
        userId: req.user.id,
        studentId: student.id,
        feature: "free-ask",
        provider: useQuestionWorkflow ? "gemini" : aiProvider,
        mode: useQuestionWorkflow ? "question-background" : shouldGenerateImage ? "mixed-background" : `${aiMode}-background`,
        tokenCost,
        input: {
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          question,
          wantsImage: shouldGenerateImage,
          provider: aiProvider,
          mode: aiMode,
          fileCount: files.length,
          intent: freeAskIntent,
          useQuestionWorkflow,
        },
        dedupeInput: {
          conversationId: conversation.id,
          question,
          wantsImage: shouldGenerateImage,
          provider: aiProvider,
          mode: aiMode,
          intent: freeAskIntent,
          useQuestionWorkflow,
          files: makeFileDedupeMeta(files),
        },
        reuseActive: false,
      });
      if (!reused) {
        startAiJob(job.id, async ({ setExternalResponseId }) => {
          await assertTokenBalance(req.user.id, tokenCost);
          const usageEvents = [];
          const collectUsage = (event) => usageEvents.push(event);
          let answer = "";
          let model = "";
          let responseProvider = aiProvider;
          let responseMode = aiMode;
          let imageBase64 = "";
          let responseMeta = {};
          if (useQuestionWorkflow) {
            const result = await generateFreeAskQuestionExplanation({ question, files, student, materialContext, onUsage: collectUsage });
            answer = result.answer;
            model = result.model;
            responseProvider = result.provider;
            responseMode = result.mode;
            responseMeta = result.meta;
          } else if (aiProvider === "gemini") {
            ensureGeminiKey();
            model = getGeminiModel(aiMode);
            answer = await generateGeminiText({
              model,
              prompt: promptText,
              files: materialContext.safeImageFiles,
              temperature: aiMode === "thinking" ? 0.2 : 0.35,
              onUsage: collectUsage,
            });
          } else {
            ensureOpenAIKey();
            model = getOpenAITextModel(aiMode);
            const imageInputs = makeImageInputs(materialContext.safeImageFiles);
            const response = await openai.responses.create({
              model,
              background: true,
              input: [
                {
                  role: "system",
                  content: freeAskSystemPrompt,
                },
                {
                  role: "user",
                  content: [{ type: "input_text", text: promptText }, ...imageInputs],
                },
              ],
            });
            await setExternalResponseId(response.id);
            const completed = await waitForOpenAIBackgroundResponse(response, { timeoutMessage: "AI自由问后台任务仍未完成，系统已尝试取消以控制费用。" });
            usageEvents.push(createOpenAIUsageEvent(completed, model));
            answer = getResponseText(completed);
          }
          if (shouldGenerateImage) {
            ensureOpenAIKey();
            const imageQualityForRequest = resolveImageQuality(question);
            const imagePrompt = [
              "Create a simple professional Chinese educational infographic image.",
              "Use clear labels, readable hierarchy, white background, and no dense text.",
              "Topic or request: " + (question || "knowledge explanation"),
              answer ? "Text answer context: " + answer.slice(0, 800) : "",
            ].filter(Boolean).join("\n");
            imageBase64 = (await generateOpenAIImageBackground(imagePrompt, setExternalResponseId, imageQualityForRequest)) || "";
            if (imageBase64) usageEvents.push(createImageUsageEvent({ quality: imageQualityForRequest }));
          }
          answer = normalizeStudentMathText(answer || "AI has read your question, but did not generate a valid answer. Please try asking in another way.");
          const assistantMessage = await insertFreeAskMessage({
            conversationId: conversation.id,
            userId: req.user.id,
            role: "assistant",
            content: answer,
            attachments: imageBase64 ? [{ name: "AI-free-ask-image.png", type: "image/png", size: 0 }] : [],
            meta: {
              provider: responseProvider,
              mode: responseMode,
              model,
              imageModel: imageBase64 ? imageModel : null,
              hasImage: Boolean(imageBase64),
              ...responseMeta,
            },
          });
          await pruneFreeAskConversationMemory(conversation.id);
          const eventPayload = { question, answer, provider: responseProvider, mode: responseMode, model, imageModel: imageBase64 ? imageModel : null, hasImage: Boolean(imageBase64) };
          if (files.length) {
            await withTransaction(async (client) => {
              const fileRows = await saveUploadedFiles(client, req.user, student, "free_ask", files);
              await client.query(
                "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'free_ask', $3, $4)",
                [student.id, req.user.id, "AI free ask", JSON.stringify({ ...eventPayload, fileIds: fileRows.map((item) => item.id) })]
              );
            });
          } else {
            await query(
              "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'free_ask', $3, $4)",
              [student.id, req.user.id, "AI free ask", JSON.stringify(eventPayload)]
            );
          }
          await recordAiUsageBilling(req.user.id, {
            jobId: job.id,
            note: "AI free ask",
            usageEvents,
            fallbackTokenCost: tokenCost,
            meta: {
              feature: "free-ask",
              provider: responseProvider,
              mode: responseMode,
              model,
              imageModel: imageBase64 ? imageModel : null,
              hasImage: Boolean(imageBase64),
            },
          });
          const latest = await getFreeAskConversationWithMessages(req.user.id, conversation.id);
          return {
            answer,
            provider: responseProvider,
            mode: responseMode,
            model,
            imageBase64,
            imageModel: imageBase64 ? imageModel : null,
            conversation: latest?.conversation || toPublicFreeAskConversation(conversation),
            userMessage: toPublicFreeAskMessage(userMessage),
            assistantMessage: toPublicFreeAskMessage(assistantMessage),
          };
        });
      }
      return res.status(202).json({ ...publicJob(job), conversation: toPublicFreeAskConversation(conversation), userMessage: toPublicFreeAskMessage(userMessage) });
    }

    let answer = "";
    let model = "";
    let imageBase64 = "";
    const usageEvents = [];
    const collectUsage = (event) => usageEvents.push(event);
    if (aiProvider === "gemini") {
      ensureGeminiKey();
      model = getGeminiModel(aiMode);
      answer = await generateGeminiText({
        model,
        prompt: promptText,
        files: materialContext.safeImageFiles,
        temperature: aiMode === "thinking" ? 0.2 : 0.35,
        onUsage: collectUsage,
      });
    } else {
      ensureOpenAIKey();
      model = getOpenAITextModel(aiMode);
      const imageInputs = makeImageInputs(materialContext.safeImageFiles);
      const response = await openai.responses.create({
        model,
        input: [
          {
            role: "system",
            content: freeAskSystemPrompt,
          },
          {
            role: "user",
            content: [{ type: "input_text", text: promptText }, ...imageInputs],
          },
        ],
      });
      usageEvents.push(createOpenAIUsageEvent(response, model));
      answer = getResponseText(response);
    }

    answer = normalizeStudentMathText(answer || "AI has read your question, but did not generate a valid answer. Please try asking in another way.");
    const assistantMessage = await insertFreeAskMessage({
      conversationId: conversation.id,
      userId: req.user.id,
      role: "assistant",
      content: answer,
      attachments: [],
      meta: { provider: aiProvider, mode: aiMode, model, hasImage: false },
    });
    await pruneFreeAskConversationMemory(conversation.id);
    const eventPayload = { question, answer, provider: aiProvider, mode: aiMode, model, imageModel: imageBase64 ? imageModel : null, hasImage: Boolean(imageBase64) };
    if (files.length) {
      await withTransaction(async (client) => {
        const fileRows = await saveUploadedFiles(client, req.user, student, "free_ask", files);
        await client.query(
          "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'free_ask', $3, $4)",
          [student.id, req.user.id, "AI free ask", JSON.stringify({ ...eventPayload, fileIds: fileRows.map((item) => item.id) })]
        );
      });
    } else {
      await query(
        "INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload) VALUES ($1, $2, 'free_ask', $3, $4)",
        [student.id, req.user.id, "AI free ask", JSON.stringify(eventPayload)]
      );
    }
    await recordAiUsageBilling(req.user.id, {
      note: "AI free ask",
      usageEvents,
      fallbackTokenCost: tokenCost,
      meta: {
        feature: "free-ask",
        provider: aiProvider,
        mode: aiMode,
        model,
        imageModel: imageBase64 ? imageModel : null,
        hasImage: Boolean(imageBase64),
      },
    });
    const latest = await getFreeAskConversationWithMessages(req.user.id, conversation.id);
    res.json({
      answer,
      provider: aiProvider,
      mode: aiMode,
      model,
      imageBase64,
      imageModel: imageBase64 ? imageModel : null,
      conversation: latest?.conversation || toPublicFreeAskConversation(conversation),
      userMessage: toPublicFreeAskMessage(userMessage),
      assistantMessage: toPublicFreeAskMessage(assistantMessage),
    });
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
  const detail = getErrorDetail(error);
  res.status(error.status || 500).json({
    error: error.code || "SERVER_ERROR",
    message: error.status ? error.message : "服务器处理失败。",
    detail,
    provider: error.provider || undefined,
    model: error.model || undefined,
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
