import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const uploadRoot = process.env.UPLOAD_DIR || path.resolve("uploads");

fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const userId = req.user?.id || "guest";
    const dir = path.join(uploadRoot, userId);
    fs.mkdirSync(dir, { recursive: true });
    callback(null, dir);
  },
  filename(req, file, callback) {
    const safeOriginal = Buffer.from(file.originalname, "latin1")
      .toString("utf8")
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
    callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeOriginal}`);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
    files: 8,
  },
});

export function toStoredFile(file) {
  return {
    originalName: file.originalname,
    filename: file.filename,
    path: file.path,
    mimeType: file.mimetype,
    size: file.size,
  };
}
