// 头像上传 + AI 初审（2026-09-24 张老师需求）
//
// 流程：登录校验 → 图片类型/大小校验 → 落盘 public/uploads/avatar/ → AI 初审
//      → 判定 pass：直接写入 user.avatar 生效；否则落 avatar_review 待审（status=10）进人工队列
//
// 关键约定：
// 1. **user.avatar 只在校验通过时才改写**。待审期间旧头像照常展示，驳回无需回滚。
// 2. 前端负责用 canvas 归一化成 JPEG（400px），这里再按 magic bytes 兜底校验。
//    智谱视觉接口不吃 GIF / HEIC（实测 400），归一化就是为了绕开这一点。
// 3. 同一用户重复上传时，旧的「待审」记录作废（被新上传取代），避免队列堆积。

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { moderateAvatar } from "@/lib/avatar-moderate";

/** 归一化后的头像约 40KB，2MB 留足余量；超过基本是绕过了前端处理 */
const MAX_SIZE = 2 * 1024 * 1024;
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "avatar");

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** 按文件头识别真实图片类型（不信任客户端声明的 MIME） */
function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return fail("请先登录", 401);

  let file: File | null;
  try {
    const form = await req.formData();
    file = form.get("avatar") as File | null;
  } catch {
    return fail("请求格式错误");
  }
  if (!file || typeof file.arrayBuffer !== "function") return fail("请选择要上传的图片");

  const buf = Buffer.from(await file.arrayBuffer());
  if (!buf.length) return fail("图片内容为空");
  if (buf.length > MAX_SIZE) return fail("图片不能超过 2MB");

  // GIF / HEIC 会在这里被拦下（智谱视觉接口不支持，前端归一化失败时才可能走到这）
  const kind = sniffImage(buf);
  if (!kind) return fail("只支持 JPG / PNG 格式的照片，请重新选择");

  const uid = session.uid;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const relPath = `/uploads/avatar/${uid}-${nowSec}.${kind.ext}`;
  const absPath = path.join(UPLOAD_DIR, path.basename(relPath));

  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(absPath, buf);
  } catch (e) {
    console.error("[avatar] 落盘失败", e);
    return fail("头像保存失败，请稍后重试", 500);
  }

  /** 落盘后若写库失败，把文件回收掉，避免留下没人引用的孤儿文件 */
  const discardFile = () => {
    try {
      if (existsSync(absPath)) unlinkSync(absPath);
    } catch {
      /* 清理失败不影响用户，忽略 */
    }
  };

  // AI 初审（未配置 Key / 超时 / 报错都会降级成 review 转人工，不会阻塞用户）
  const ai = await moderateAvatar(buf, kind.mime);

  let prevAvatar = "";
  try {
    const current = await prisma.user.findUnique({
      where: { id: BigInt(uid) },
      select: { avatar: true },
    });
    prevAvatar = current?.avatar ?? "";

    // 该用户此前未审完的记录直接作废清掉，避免队列里堆同一人的历史版本
    await prisma.avatarReview.deleteMany({
      where: { user: BigInt(uid), status: AVATAR_REVIEW_STATUS.PENDING },
    });
  } catch (e) {
    console.error("[avatar] 读取/清理旧记录失败", e);
    discardFile();
    return fail("头像保存失败，请稍后重试", 500);
  }

  if (ai.verdict === "pass") {
    try {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: BigInt(uid) },
          data: { avatar: relPath, updateTime: nowSec },
        }),
        prisma.avatarReview.create({
          data: {
            user: BigInt(uid),
            filepath: relPath,
            status: AVATAR_REVIEW_STATUS.APPROVED,
            verdict: ai.verdict,
            source: ai.source,
            category: ai.category,
            reason: ai.reason,
            prevAvatar,
            reviewer: BigInt(0), // 0 = 无人工参与，AI 自动放行
            reviewTime: nowSec,
            createTime: nowSec,
          },
        }),
      ]);
    } catch (e) {
      console.error("[avatar] 写入失败", e);
      discardFile();
      return fail("头像保存失败，请稍后重试", 500);
    }
    return NextResponse.json({ ok: true, auto: true, avatar: relPath, message: "头像已更新" });
  }

  try {
    await prisma.avatarReview.create({
      data: {
        user: BigInt(uid),
        filepath: relPath,
        status: AVATAR_REVIEW_STATUS.PENDING,
        verdict: ai.verdict,
        source: ai.source,
        category: ai.category,
        reason: ai.reason,
        prevAvatar,
        createTime: nowSec,
      },
    });
  } catch (e) {
    console.error("[avatar] 写入待审记录失败", e);
    discardFile();
    return fail("头像保存失败，请稍后重试", 500);
  }

  return NextResponse.json({
    ok: true,
    auto: false,
    status: AVATAR_REVIEW_STATUS.PENDING,
    message: "已提交，等待管理员审核",
  });
}
