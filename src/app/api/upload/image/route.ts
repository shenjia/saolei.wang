// BBS 贴图上传（2026-09-25 张老师需求：编辑器贴图传线上服务器，每张最大 200K）
//
// 流程：登录校验 → magic bytes 识别真实类型（JPEG/GIF/PNG/WebP 白名单）→ 服务端二次限 200K
//      → 落盘 public/uploads/bbs/ → 返回 URL
// 前端（RichEditor.compressToBudget）已把位图压成 ≤200K 的 JPEG；GIF 走直传（前端已拦 200K）。
// 这里服务端再校验一遍，不信任客户端。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const MAX_SIZE = 200 * 1024;
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "bbs");

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** 按文件头识别真实图片类型（不信任客户端声明的 MIME） */
function sniffImage(buf: Buffer): { ext: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg" };
  }
  if (
    buf.length > 6 &&
    buf.toString("ascii", 0, 3) === "GIF"
  ) {
    return { ext: "gif" };
  }
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ext: "png" };
  }
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp" };
  }
  return null;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return fail("请先登录", 401);

  let file: File | null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return fail("请求格式错误");
  }
  if (!file || typeof file.arrayBuffer !== "function") return fail("请选择要上传的图片");

  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.length) return fail("图片内容为空");
  if (buf.length > MAX_SIZE) return fail("图片不能超过 200K，请压缩后重试");

  const kind = sniffImage(buf);
  if (!kind) return fail("只支持 JPG / PNG / GIF / WebP 格式的图片");

  const relPath = `/uploads/bbs/${session.uid}-${Date.now()}-${randomUUID().slice(0, 8)}.${kind.ext}`;
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(path.join(UPLOAD_DIR, path.basename(relPath)), buf);
  } catch (e) {
    console.error("[bbs-upload] 落盘失败", e);
    return fail("图片保存失败，请稍后重试", 500);
  }

  return NextResponse.json({ ok: true, url: relPath });
}
