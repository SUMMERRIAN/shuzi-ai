import jwt from "jsonwebtoken";
import { query } from "./db.js";

export function signToken(user) {
  const secret = process.env.JWT_SECRET || "dev-only-change-me";
  return jwt.sign(
    {
      sub: user.id,
      identifier: user.identifier,
      role: user.role,
    },
    secret,
    { expiresIn: "30d" }
  );
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "AUTH_REQUIRED", message: "请先登录。" });
    const secret = process.env.JWT_SECRET || "dev-only-change-me";
    const payload = jwt.verify(token, secret);
    const result = await query("SELECT * FROM users WHERE id = $1", [payload.sub]);
    if (!result.rows[0]) return res.status(401).json({ error: "AUTH_INVALID", message: "登录状态已失效。" });
    req.user = result.rows[0];
    next();
  } catch (error) {
    res.status(401).json({ error: "AUTH_INVALID", message: "登录状态已失效。", detail: error.message });
  }
}

export function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_SETUP_TOKEN;
  const provided = req.headers["x-admin-token"] || req.body?.adminToken;
  if (!expected || provided !== expected) {
    return res.status(403).json({ error: "ADMIN_TOKEN_REQUIRED", message: "需要管理员令牌。" });
  }
  next();
}
