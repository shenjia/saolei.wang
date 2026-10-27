// UGC 内容 AI 复审调度（2026-10-13）
//
// 调用时机：论坛发主题/回复、录像评论「发表成功之后」异步触发（route 里用 next/server 的 after()）。
// 处理规则：AI 判 review → 把该条内容置为「待审」（CONTENT_STATUS.PENDING，前台不可见），
//          并同步 ①回退冗余条数 ②撤下这条内容产生的动态。AI 判 pass / 调用失败 → 不动。
//
// 幂等：只处理 status 仍为 NORMAL 的记录；重复调用、内容已被删除/编辑过都会安全跳过。
// 计数口径：见 config.ts 的 countsInTotal——只有 NORMAL 计入 video_stat.comments / bbs_post.replies。

import { prisma } from "./db";
import { CONTENT_STATUS, NEWS_TYPE } from "./config";
import { moderateText, textModerationEnabled, TEXT_CATEGORY_NAMES } from "./text-moderate";
import { retractReplyNotice } from "./message";
import type { TextModerationResult } from "./text-moderate";

export type ContentKind = "comment" | "bbs_post" | "bbs_reply";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const B = (v: bigint | number): bigint => BigInt(v);

/**
 * 存库的判定摘要：`类别：理由`，供管理后台在待审行上直接展示。
 * 长度对齐 ai_reason 列 varchar(200)。
 * AI 的 reason 有时直接就是类别名（如「广告推广」），此时不重复拼前缀，避免「广告推广：广告推广」。
 */
function pendingNote(result: TextModerationResult): string {
  const name = TEXT_CATEGORY_NAMES[result.category] ?? "可疑内容";
  const reason = (result.reason ?? "").trim();
  const note = !reason || reason === name || reason.startsWith(name)
    ? reason || name
    : `${name}：${reason}`;
  return note.slice(0, 200);
}

/**
 * 对一条已发布内容做 AI 复审。设计为「发后执行」，调用方不 await 结果即可（用 after 包裹）。
 */
export async function runContentReview(kind: ContentKind, id: number, text: string): Promise<void> {
  if (!textModerationEnabled()) return;
  try {
    const result = await moderateText(text);
    if (result.verdict !== "review") return;
    const note = pendingNote(result);
    const changed = await markPending(kind, id, note);
    if (changed) {
      console.warn(`[content-review] AI 转待审 kind=${kind} id=${id} cat=${result.category} note=${note}`);
    }
  } catch (err) {
    // 复审链路自身出错绝不能影响已成功的发布——只记日志
    console.warn(
      `[content-review] 复审异常 kind=${kind} id=${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 把内容置为待审，并回退计数、撤下动态。返回是否真的发生了状态变更。 */
async function markPending(kind: ContentKind, id: number, note: string): Promise<boolean> {
  const now = nowSec();

  if (kind === "comment") {
    const row = await prisma.comment.findUnique({
      where: { id: B(id) },
      select: { id: true, video: true, user: true, status: true },
    });
    if (!row || row.status !== CONTENT_STATUS.NORMAL) return false;
    await prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: row.id },
        data: { status: CONTENT_STATUS.PENDING, aiReason: note, updateTime: now },
      });
      await tx.videoStat.updateMany({
        where: { id: row.video },
        data: { comments: { decrement: 1 }, updateTime: now },
      });
      // 撤下该条评论的动态：按 details_data 里的 cid（= 评论 id）精确定位。
      // 不能只按 createTime——同一用户在同一录像下同秒发两条评论时，时间完全相同会误删另一条。
      await tx.news.deleteMany({
        where: {
          type: NEWS_TYPE.COMMENT,
          user: row.user,
          reference: row.video,
          detailsData: { contains: `"cid":${id}}` },
        },
      });
    });
    return true;
  }

  if (kind === "bbs_post") {
    const row = await prisma.bbsPost.findUnique({
      where: { id: B(id) },
      select: { id: true, user: true, status: true },
    });
    if (!row || row.status !== CONTENT_STATUS.NORMAL) return false;
    await prisma.$transaction(async (tx) => {
      await tx.bbsPost.update({
        where: { id: row.id },
        data: { status: CONTENT_STATUS.PENDING, aiReason: note, updateTime: now },
      });
      await tx.news.deleteMany({
        where: {
          type: NEWS_TYPE.ARTICLE,
          user: row.user,
          reference: row.id,
          detailsData: { contains: `"cid":${id}}` },
        },
      });
    });
    return true;
  }

  // bbs_reply
  const row = await prisma.bbsReply.findUnique({
    where: { id: B(id) },
    select: { id: true, post: true, user: true, status: true },
  });
  if (!row || row.status !== CONTENT_STATUS.NORMAL) return false;
  await prisma.$transaction(async (tx) => {
    await tx.bbsReply.update({
      where: { id: row.id },
      data: { status: CONTENT_STATUS.PENDING, aiReason: note, updateTime: now },
    });
    await tx.bbsPost.update({
      where: { id: row.post },
      data: { replies: { decrement: 1 }, updateTime: now },
    });
    await tx.news.deleteMany({
      where: {
        type: NEWS_TYPE.COMMENT,
        user: row.user,
        reference: row.post,
        detailsData: { contains: `"cid":${id}}` },
      },
    });
    // 2026-10-27 张老师要求：AI 转待审同步撤通知消息——评论前台已不可见，
    // 通知再留着就是「点进去看不到评论」的死链（24474 案例：发布 2 秒后被转待审，
    // 楼主收到的通知成了空指向）
    await retractReplyNotice(Number(row.user), id, tx);
  });
  return true;
}
