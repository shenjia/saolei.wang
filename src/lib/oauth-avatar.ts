// QQ 绑定成功后拉取头像并送审（2026-10-26 张老师需求）
//
// 数据源：OAuth 授权时 get_user_info 已拉到 figureurl_qq_2（100×100）/ figureurl_qq_1
// （40×40），存在 ticket.avatar / user_oauth.avatar。绑定成功后下载该 URL：
// - 限 2MB、magic bytes 校验（同上传头像口径），GIF/HEIC 等直接放弃
// - 落盘 /uploads/avatar/{uid}-qq-{ts}.{ext}
// - AI 初审仅作参考意见（verdict/category/reason 展示在审核队列），**一律落
//   PENDING 进人工队列**（张老师口径：拉取头像 → 进入审核队列；QQ 头像
//   大量是动漫/风景图，AI 误放行风险实测存在，不自动生效）
// - 全程 try/catch 吞错（头像失败绝不能影响绑定流程），仅 console 留痕
//
// source 标记 "qq"：管理后台 AiVerdict 显示「QQ 头像」来源标签。

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { moderateAvatar } from "@/lib/avatar-moderate";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";

const MAX_SIZE = 2 * 1024 * 1024;
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "avatar");
const DOWNLOAD_TIMEOUT_MS = 8000;

/** 与 api/account/avatar 同口径的 magic bytes 识别 */
function sniffImage(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "png";
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) return "webp";
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * QQ 绑定成功后拉取授权头像并送审。任何失败都只打日志，不抛出。
 * @param uid    user.id
 * @param avatarUrl QQ get_user_info 返回的头像外链（figureurl_qq_2 优先）
 */
export async function importQqAvatar(uid: number, avatarUrl: string): Promise<void> {
  if (!avatarUrl || !/^https?:\/\//.test(avatarUrl)) return;
  try {
    // 1. 下载（超时保护；QQ 头像 CDN 第三方网址，仅取图片二进制）
    const resp = await fetch(avatarUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!resp.ok) {
      console.warn(`[qq-avatar] 下载失败 HTTP ${resp.status}: ${avatarUrl}`);
      return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_SIZE) {
      console.warn(`[qq-avatar] 大小异常 ${buf.length}B，放弃`);
      return;
    }

    // 2. 类型校验（QQ 头像多为 jpg/png/webp；gif 动图 AI 接口不吃，直接放弃）
    const ext = sniffImage(buf);
    if (!ext) {
      console.warn(`[qq-avatar] 不支持的图片格式，放弃`);
      return;
    }

    // 3. 落盘
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const relPath = `/uploads/avatar/${uid}-qq-${nowSec}.${ext}`;
    const absPath = path.join(UPLOAD_DIR, path.basename(relPath));
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(absPath, buf);

    const discard = () => {
      try {
        if (existsSync(absPath)) unlinkSync(absPath);
      } catch {
        /* 忽略 */
      }
    };

    // 4. AI 初审仅作参考（不自动放行）：QQ 头像大量是动漫/风景/文字图，
    //    实测模型对非人脸图有误放行（花卉判 pass），一律转人工定夺
    const ai = await moderateAvatar(buf, MIME_BY_EXT[ext]);
    const reason = `QQ 授权头像，${ai.reason}`;

    const current = await prisma.user.findUnique({
      where: { id: BigInt(uid) },
      select: { avatar: true },
    });
    const prevAvatar = current?.avatar ?? "";

    // 清掉同用户旧的待审记录（同上传口径：新送审取代旧版本）
    await prisma.avatarReview.deleteMany({
      where: { user: BigInt(uid), status: AVATAR_REVIEW_STATUS.PENDING },
    });

    await prisma.avatarReview.create({
      data: {
        user: BigInt(uid),
        filepath: relPath,
        status: AVATAR_REVIEW_STATUS.PENDING,
        verdict: ai.verdict,
        source: "qq",
        category: ai.category,
        reason,
        prevAvatar,
        createTime: nowSec,
      },
    });
    console.log(`[qq-avatar] user ${uid} 已进人工审核队列（AI 参考：${ai.verdict}/${ai.category}）`);
  } catch (e) {
    console.warn("[qq-avatar] 导入失败（不影响绑定）:", e instanceof Error ? e.message : e);
  }
}
