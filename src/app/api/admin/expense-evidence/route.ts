// 支出凭据图片上传（2026-10-30 收支管理）
// 管理员选图后先传这里拿 URL，再连同用途/金额一起走 expense.add 落库。
// 落盘 public/uploads/expense/（nginx /uploads/ location 直读）；
// 图片按 magic bytes 识别 jpg/png/webp，8MB 上限（凭据截图不再做 canvas 归一化）。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

const MAX_SIZE = 8 * 1024 * 1024;
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "expense");

function sniffImage(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return "png";
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

export async function POST(req: Request) {
  const guard = await requireAdminApi("manager");
  if ("error" in guard) return guard.error;

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }
  if (!file || typeof file === "string") {
    return NextResponse.json({ ok: false, error: "缺少图片文件" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ ok: false, error: "图片超过 8MB 上限" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffImage(buf);
  if (!ext) {
    return NextResponse.json({ ok: false, error: "仅支持 JPG / PNG / WebP 图片" }, { status: 400 });
  }
  mkdirSync(UPLOAD_DIR, { recursive: true });
  // 文件名：时间戳 + 随机后缀，避免猜ID遍历与重名覆盖
  const name = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return NextResponse.json({ ok: true, url: `/uploads/expense/${name}` });
}
