# 树子AI后端基础版

这个后端负责第一阶段正式化能力：

- PostgreSQL 学生档案数据库
- 注册 / 登录 / 当前账号状态
- 会员状态、容量额度
- 手动会员开通接口
- 学情问卷、学情陈述写入学生档案
- 试卷/错题图片分析、语音转写、相似题生成和知识图生成

## 环境变量

复制 `.env.example` 为 `.env`，至少配置：

```bash
DATABASE_URL=postgres://shuzi_ai:your_password@127.0.0.1:5432/shuzi_ai
JWT_SECRET=change-this-secret
ADMIN_SETUP_TOKEN=change-this-admin-token
PORT=3001
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL_TEXT=gpt-5
OPENAI_MODEL_IMAGE=gpt-5
OPENAI_MODEL_TRANSCRIBE=gpt-4o-mini-transcribe
UPLOAD_DIR=/var/www/shuzi-ai/uploads
```

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
