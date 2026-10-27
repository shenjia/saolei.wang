// QQ 绑定成功后拉取头像并送审（2026-10-26 张老师需求）
//
// 数据源：OAuth 授权时 get_user_info 已拉到 figureurl_qq_2（100×100）/ figureurl_qq_1
// （40×40），存在 ticket.avatar / user_oauth.avatar。绑定成功后下载该 URL：
// - **仅当本人还没传过照片时**才自动同步（2026-10-27 张老师口径）：user.avatar 已是
//   上传路径（/uploads/avatar/）或旧站实体照片标记 "1" → 默认跳过，绝不悄悄替换本人照片；
//   本人还有自传头像在审核中（avatar_review 待审且 source≠qq）→ 同样跳过，避免把
//   他的待审记录清掉
// - **本人已有照片时改为「问一句」**（2026-10-27 追加）：绑定后带 ?qqavatar=1 回到账户页，
//   由 QqAvatarPrompt 浮窗并排展示「当前头像 → QQ 头像」，用户点「换成 QQ 头像」才走
//   force=true 导入（接口 /api/account/avatar/qq）
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
import { AVATAR_REVIEW_STATUS, isUploadedAvatar } from "@/lib/avatar";

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
 * 本人是否已经传过自己的照片（2026-10-27 张老师口径：有照片就不动他的头像）
 * - "/uploads/avatar/..." → 新版自传头像（AI 放行或人工通过后写入）
 * - "1" → 旧站迁移标记位，实体照片在 /images/player/{id}.jpg
 * 其余（"0" / "" / OAuth 外链）都算「还没传照片」，可以同步 QQ 头像。
 */
export function hasOwnAvatarPhoto(avatar: string): boolean {
  return isUploadedAvatar(avatar) || avatar === "1";
}

/** importQqAvatar 的结果：进队列 / 按口径跳过 / 拉取或写库失败 */
export type QqAvatarImportResult = "queued" | "skipped" | "failed";

/**
 * QQ 绑定成功后拉取授权头像并送审。任何失败都只打日志，不抛出。
 * 本人已有照片（或自传照片正在审核）时默认跳过，什么都不做；
 * 用户在浮窗里明确选了「换成 QQ 头像」时传 force=true 绕过这两道闸门。
 * @param uid    user.id
 * @param avatarUrl QQ get_user_info 返回的头像外链（figureurl_qq_2 优先）
 * @param opts.force 用户已确认替换（本人原头像照旧保留到审核通过为止）
 */
export async function importQqAvatar(
  uid: number,
  avatarUrl: string,
  opts: { force?: boolean } = {},
): Promise<QqAvatarImportResult> {
  if (!avatarUrl || !/^https?:\/\//.test(avatarUrl)) return "failed";
  try {
    const current = await prisma.user.findUnique({
      where: { id: BigInt(uid) },
      select: { avatar: true },
    });
    const prevAvatar = current?.avatar ?? "";

    // 0. 前置闸门（force 时跳过——用户已在浮窗里明确同意替换）
    if (!opts.force) {
      // 本人已传过照片 → 不同步（绝不覆盖）
      if (hasOwnAvatarPhoto(prevAvatar)) {
        console.log(`[qq-avatar] user ${uid} 已有本人照片（${prevAvatar}），跳过 QQ 头像同步`);
        return "skipped";
      }
      // 本人自传头像在审 → 也不插队，否则下面 deleteMany 会把他自己待审的记录清掉
      const ownPending = await prisma.avatarReview.findFirst({
        where: {
          user: BigInt(uid),
          status: AVATAR_REVIEW_STATUS.PENDING,
          source: { not: "qq" },
        },
        select: { id: true },
      });
      if (ownPending) {
        console.log(`[qq-avatar] user ${uid} 有自传头像待审（#${ownPending.id}），跳过 QQ 头像同步`);
        return "skipped";
      }
    }

    // 1. 下载（超时保护；QQ 头像 CDN 第三方网址，仅取图片二进制）
    const resp = await fetch(avatarUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!resp.ok) {
      console.warn(`[qq-avatar] 下载失败 HTTP ${resp.status}: ${avatarUrl}`);
      return "failed";
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_SIZE) {
      console.warn(`[qq-avatar] 大小异常 ${buf.length}B，放弃`);
      return "failed";
    }

    // 2. 类型校验（QQ 头像多为 jpg/png/webp；gif 动图 AI 接口不吃，直接放弃）
    const ext = sniffImage(buf);
    if (!ext) {
      console.warn(`[qq-avatar] 不支持的图片格式，放弃`);
      return "failed";
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
    return "queued";
  } catch (e) {
    console.warn("[qq-avatar] 导入失败（不影响绑定）:", e instanceof Error ? e.message : e);
    return "failed";
  }
}
