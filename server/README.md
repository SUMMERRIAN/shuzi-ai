# 树子AI后端基础版

这个后端负责第一阶段正式化能力：

- PostgreSQL 学生档案数据库
- 注册 / 登录 / 当前账号状态
- 会员状态、容量额度
- 手动会员开通接口
- 学情问卷、学情陈述写入学生档案
- 试卷/错题图片分析、相似题生成和知识图生成

## 环境变量

复制 `.env.example` 为 `.env`，至少配置：

```bash
DATABASE_URL=postgres://shuzi_ai:your_password@127.0.0.1:5432/shuzi_ai
JWT_SECRET=change-this-secret
ADMIN_SETUP_TOKEN=change-this-admin-token
PORT=3001
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL_TEXT=gpt-5.4-mini
OPENAI_MODEL_FAST=gpt-5.4-mini
OPENAI_MODEL_THINKING=gpt-5.4
OPENAI_MODEL_IMAGE=gpt-image-2
OPENAI_IMAGE_GENERATION_ENABLED=true
OPENAI_IMAGE_QUALITY=medium
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_TIMEOUT_MS=240000
FREE_ASK_MAX_FILES=8
FREE_ASK_MAX_IMAGE_FILES=5
FREE_ASK_MAX_IMAGE_MB=8
FREE_ASK_MAX_DOCUMENT_CHARS=32000
FREE_ASK_MAX_CHARS_PER_DOCUMENT=12000
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL_FAST=gemini-3.5-flash
GEMINI_MODEL_THINKING=gemini-3.5-flash
GEMINI_MODEL_MISTAKE=gemini-3.5-flash
GEMINI_MODEL_MISTAKE_HIGH=gemini-3.5-flash
GEMINI_TIMEOUT_MS=120000
GEMINI_MAX_OUTPUT_TOKENS=4096
GEMINI_MODEL_COOLDOWN_MS=600000
GEMINI_MISTAKE_RETRY_DELAYS_MS=30000,90000,180000
GEMINI_MODEL_MISTAKE_RECOGNITION=gemini-3.5-flash
GEMINI_MISTAKE_RECOGNITION_MAX_OUTPUT_TOKENS=2048
GEMINI_MISTAKE_EXPLANATION_MAX_OUTPUT_TOKENS=4096
AI_BILLING_MARKUP=3.5
TOKENS_PER_CNY=100
USD_TO_CNY=7.3
AI_MIN_CHARGE_TOKENS=1
AI_COMPLETED_JOB_REUSE_MINUTES=5
UPLOAD_DIR=/var/www/shuzi-ai/uploads
```

AI billing is based on actual provider usage when the API returns token/image usage. The system converts provider USD cost to CNY with USD_TO_CNY, multiplies by AI_BILLING_MARKUP, then converts to user-facing points with TOKENS_PER_CNY. Fixed point amounts are only fallback values when the provider does not return usage. Identical completed background jobs can be reused within AI_COMPLETED_JOB_REUSE_MINUTES to avoid repeated billing. Image generation uses OPENAI_MODEL_IMAGE and requires OPENAI_IMAGE_GENERATION_ENABLED=true.

语音陈述转写接口当前已关闭，学情陈述请使用文字填写。

## 启动

```bash
npm run server
```

## 管理员手动开通会员

```bash
curl -X POST http://127.0.0.1:3001/api/admin/memberships/activate \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_SETUP_TOKEN" \
  -d '{"identifier":"student@example.com","planId":"monthly"}'
```

## 管理员手动调整余额

```bash
curl -X POST http://127.0.0.1:3001/api/admin/lt/recharge \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_SETUP_TOKEN" \
  -d '{"identifier":"student@example.com","packageId":"lt-990"}'
```
