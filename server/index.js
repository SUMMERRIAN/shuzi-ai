import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { ensureSchema } from "./schema.js";
import { query, withTransaction } from "./db.js";
import { requireAdminToken, requireAuth, signToken } from "./auth.js";
import { ltPackages, membershipPlans, storageExpansionPackages, tokenBillingRules } from "./plans.js";
import { upload, toStoredFile } from "./uploads.js";
import { ensureOpenAIKey, getGeneratedImageBase64, getResponseText, openai, parseJsonText, readFileAsDataUrl } from "./openaiClient.js";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: "5mb" }));

const textModel = process.env.OPENAI_MODEL_TEXT || "gpt-5";
const imageModel = process.env.OPENAI_MODEL_IMAGE || "gpt-5";
const transcriptionModel = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe";

function normalizeIdentifier(identifier = "") {
  return String(identifier).trim().toLowerCase();
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
    await client.query("UPDATE learning_token_wallets SET balance = GREATEST(balance - $2, 0), updated_at = now() WHERE user_id = $1", [
      userId,
      tokens,
    ]);
    await client.query(
      `INSERT INTO learning_token_transactions (user_id, amount, type, source, note, meta)
       VALUES ($1, $2, 'consume', 'ai_action', $3, $4)`,
      [userId, -tokens, note, JSON.stringify(meta)]
    );
  });
}

async function saveUploadedFiles(client, user, student, purpose, files) {
  const saved = [];
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

function makeImageInputs(files) {
  return files
    .filter((file) => (file.mimetype || "").startsWith("image/"))
    .slice(0, 6)
    .map((file) => ({
      type: "input_image",
      image_url: readFileAsDataUrl(file),
    }));
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
      baseMb: storage?.base_mb || 50,
      expansionMb: storage?.expansion_mb || 0,
      usedBytes: Number(storage?.used_bytes || 0),
      totalMb: (storage?.base_mb || 50) + (storage?.expansion_mb || 0),
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
      `SELECT id, order_type, package_id, title, amount_cny, status, created_at, paid_at
       FROM payment_orders
       WHERE user_id = $1
         AND status = 'paid'
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

app.post("/api/ai/paper-analysis", requireAuth, upload.array("files", 8), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "FILES_REQUIRED", message: "请上传试卷、错题或作业图片。" });
    const student = await getPrimaryStudent(req.user);
    const { subject = "", examName = "", note = "" } = req.body || {};
    const imageInputs = makeImageInputs(files);
    if (!imageInputs.length) {
      return res.status(400).json({ error: "IMAGE_REQUIRED", message: "当前AI视觉分析请先上传图片文件。" });
    }
    const response = await openai.responses.create({
      model: textModel,
      input: [
        {
          role: "system",
          content:
            "你是树子AI的试卷与作业分析智能体。只分析上传材料中的错题、题型、知识漏洞、方法缺口、审题步骤、书写表达和后续训练建议，不制定完整周计划。",
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${jsonInstruction(
                "{summary, extracted_questions:[{title, content, student_answer, correct_answer, error_type}], wrong_types, knowledge_gaps, method_gaps, evidence, training_suggestions:[{task, detail, standard}]}"
              )}\n科目：${subject}\n试卷/作业名称：${examName}\n学生补充说明：${note}`,
            },
            ...imageInputs,
          ],
        },
      ],
    });
    const report = parseJsonText(getResponseText(response), { summary: "AI已完成分析，但返回格式需要人工复核。" });
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "paper_analysis", files);
      const uploadRow = (
        await client.query(
          `INSERT INTO paper_uploads (student_id, user_id, subject, exam_name, note, file_ids)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, subject, examName, note, fileRows.map((item) => item.id)]
        )
      ).rows[0];
      const reportRow = (
        await client.query(
          `INSERT INTO paper_analysis_reports (paper_upload_id, student_id, user_id, report)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [uploadRow.id, student.id, req.user.id, JSON.stringify(report)]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'paper_analysis', $3, $4)`,
        [student.id, req.user.id, `${subject || "试卷"}分析`, JSON.stringify({ upload: uploadRow, report })]
      );
      return { upload: uploadRow, report: reportRow, files: fileRows };
    });
    await recordTokenUsage(req.user.id, 18, "AI试卷分析", { feature: "paper-analysis", reportId: saved.report?.id });
    res.json({ report, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/transcribe", requireAuth, upload.single("audio"), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
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

app.post("/api/ai/mistakes/analyze", requireAuth, upload.array("files", 6), async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "FILES_REQUIRED" });
    const student = await getPrimaryStudent(req.user);
    const { subject = "", title = "错题分析", note = "" } = req.body || {};
    const response = await openai.responses.create({
      model: textModel,
      input: [
        {
          role: "system",
          content:
            "你是树子AI错题专项智能体。只围绕错题识别、错因归类、解题方法、相似题训练建议和复测安排输出。",
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${jsonInstruction(
                "{mistake_title, subject, question_content, error_reason, knowledge_points, method_gap, correction_steps, similar_question_requirements, review_schedule}"
              )}\n科目：${subject}\n标题：${title}\n学生补充：${note}`,
            },
            ...makeImageInputs(files),
          ],
        },
      ],
    });
    const analysis = parseJsonText(getResponseText(response), { mistake_title: title });
    const saved = await withTransaction(async (client) => {
      const fileRows = await saveUploadedFiles(client, req.user, student, "mistake", files);
      const row = (
        await client.query(
          `INSERT INTO mistake_files (student_id, user_id, subject, title, file_ids, analysis)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student.id, req.user.id, subject, title, fileRows.map((item) => item.id), JSON.stringify(analysis)]
        )
      ).rows[0];
      await client.query(
        `INSERT INTO student_archive_events (student_id, user_id, event_type, title, payload)
         VALUES ($1, $2, 'mistake_analysis', $3, $4)`,
        [student.id, req.user.id, title, JSON.stringify({ analysis })]
      );
      return row;
    });
    await recordTokenUsage(req.user.id, 12, "AI错题识别", { feature: "mistake-analyze", mistakeId: saved.id });
    res.json({ analysis, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/mistakes/practice", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    const student = await getPrimaryStudent(req.user);
    const { sourceMistakeId = null, subject = "", mistake = {}, count = 3 } = req.body || {};
    const response = await openai.responses.create({
      model: textModel,
      input: [
        {
          role: "system",
          content:
            "你是树子AI相似题训练智能体。根据错题的知识点、方法缺口和错误类型，生成1-3道相似题，必须包含答案、步骤和训练目的。",
        },
        {
          role: "user",
          content: `${jsonInstruction(
            "{questions:[{title, question, answer, solution_steps, training_goal, difficulty}]}"
          )}\n科目：${subject}\n数量：${Math.min(3, Math.max(1, Number(count) || 1))}\n错题信息：${JSON.stringify(mistake)}`,
        },
      ],
    });
    const generated = parseJsonText(getResponseText(response), { questions: [] });
    const saved = (
      await query(
        `INSERT INTO generated_practice (student_id, user_id, source_mistake_id, questions)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [student.id, req.user.id, sourceMistakeId, JSON.stringify(generated.questions || generated)]
      )
    ).rows[0];
    await recordTokenUsage(req.user.id, 10, "AI生成相似题", { feature: "mistake-practice", practiceId: saved.id });
    res.json({ practice: generated, saved });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/knowledge-note", requireAuth, async (req, res, next) => {
  try {
    await assertPaidMember(req.user.id);
    ensureOpenAIKey();
    const student = await getPrimaryStudent(req.user);
    const { topic = "", grade = "", subject = "" } = req.body || {};
    if (!topic.trim()) return res.status(400).json({ error: "TOPIC_REQUIRED" });
    const prompt =
      `请为学生制作一张严谨、丰富、适合复习的中文知识图。主题：${topic}。学科：${subject || "不限"}。年级：${grade || "中学生"}。` +
      "画面要求：信息量充足，包含标题、结构图、标注线、关键概念解释、底部总结，不要做简单示意图，风格专业清晰。";
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
  await query("UPDATE storage_quotas SET base_mb = $2, updated_at = now() WHERE user_id = $1", [user.id, plan.storageMb]);
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
