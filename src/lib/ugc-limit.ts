// UGC 未上榜限制（2026-11-09 张老师要求，李浩宇 48 条群号广告私信事件的后续政策）
//
// 口径：「未上榜」与 bbs.canPost 同源——user_scores 四项成绩时间（sum/beg/int/exp）全 0，
//   即任一级别都无有效成绩（含初级/中级，口径一致避免两套判定）。
// 豁免：管理员（userAuth.role>=10，isManager）或信任用户（user.trusted）。
// 未上榜用户权限（2026-11-09 张老师定稿）：
//   · 论坛主题：24h 内 1 个（写入行计数，被屏蔽/待审行也计入防删帖重发绕过）；
//   · 论坛回复：只能回复「自己发布的主题」（不限次数——在自己帖子里答复楼层是正常互动）；
//   · 录像评论：按级别解锁（2026-11-19 张老师改口径，原「未上榜全禁」废止）——
//     上传过某级别录像（status<>0 有效件）才能评论该级别录像（checkCommentLevel）；
//   · 私信：只能发给管理员，或回复「对方 7 天内先发来的」消息（isSystem=false，含评论/回复
//     通知模板——新手被评论后可回复，构成正常对话回路）。
// 已有闸门不变：前置词库 checkSensitive + AI 后审 runContentReview + 私信反群发三闸门。

import { prisma } from "./db";
import { isManager } from "./config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const DAY = 86400;

export const UGC_MAX_POSTS = 1;
export const DM_REPLY_WINDOW_DAYS = 7;

/** 未上榜且非豁免（管理员/信任用户）→ true；role 传入可跳过管理员判定减少查询 */
export async function ugcRestricted(userId: number, role?: number): Promise<boolean> {
  if (role !== undefined && isManager(role)) return false;
  const scores = await prisma.userScores.findUnique({
    where: { id: BigInt(userId) },
    select: { sumTime: true, begTime: true, intTime: true, expTime: true },
  });
  const ranked =
    !!scores &&
    N(scores.sumTime) + N(scores.begTime) + N(scores.intTime) + N(scores.expTime) > 0;
  if (ranked) return false;
  const u = await prisma.user.findUnique({ where: { id: BigInt(userId) }, select: { trusted: true } });
  return !u?.trusted;
}

/**
 * 未上榜用户 24h 发主题配额。超限返回拒绝文案，null=放行。
 * 调用方须先判定 canPost（上榜用户直接放行，不走本函数）。
 */
export async function checkUgcPostQuota(userId: number): Promise<string | null> {
  const since = BigInt(Math.floor(Date.now() / 1000) - DAY);
  const used = await prisma.bbsPost.count({
    where: { user: BigInt(userId), createTime: { gte: since } },
  });
  if (used >= UGC_MAX_POSTS) {
    return `24 小时内最多发布 ${UGC_MAX_POSTS} 个主题，请明日再试（上传任一级别成绩加入排行后不受限）`;
  }
  return null;
}

/**
 * 未上榜用户回帖对象限制：只能回复自己发布的主题。允许返回 null，否则拒绝文案。
 * 调用方须先判定 canPost（上榜用户直接放行，不走本函数）。
 */
export async function checkReplyOwnPost(userId: number, postId: number): Promise<string | null> {
  const post = await prisma.bbsPost.findUnique({
    where: { id: BigInt(postId) },
    select: { user: true },
  });
  if (!post) return null; // 主题不存在走后续 createReply 的 404 通道，不在此拦截
  if (N(post.user) === userId) return null;
  return "未上榜用户只能回复自己发布的主题（上传任一级别成绩加入排行后不受限）";
}

/**
 * 录像评论级别限制（2026-11-09 张老师要求）：上传过该级别录像（status<>0，待审 10/
 * 通过 20 均算，屏蔽 0 不算）才能评论该级别录像——评高级先打高级，评初级先打初级。
 * 对全体用户生效（不限未上榜）；管理员/信任用户豁免。返回 null=放行，否则拒绝文案。
 */
export async function checkCommentLevel(
  userId: number,
  role: number | undefined,
  level: string
): Promise<string | null> {
  if (role !== undefined && isManager(role)) return null;
  const u = await prisma.user.findUnique({ where: { id: BigInt(userId) }, select: { trusted: true } });
  if (u?.trusted) return null;
  const uploaded = await prisma.video.count({
    where: { user: BigInt(userId), level, status: { not: 0 } },
  });
  if (uploaded > 0) return null;
  return "上传过该级别录像后才能评论该级别录像";
}

/**
 * 未上榜用户发私信对象白名单：收件人是管理员，或对方 7 天内给我发过消息（含通知模板）。
 * 超出白名单返回拒绝文案，null=放行。调用方须先判定 ugcRestricted。
 */
export async function checkDmAudience(fromUserId: number, toUserId: number): Promise<string | null> {
  const to = await prisma.userAuth.findUnique({
    where: { id: BigInt(toUserId) },
    select: { role: true },
  });
  if (to && isManager(to.role)) return null;
  const since = BigInt(Math.floor(Date.now() / 1000) - DM_REPLY_WINDOW_DAYS * DAY);
  const inbound = await prisma.message.count({
    where: {
      fromUser: BigInt(toUserId),
      toUser: BigInt(fromUserId),
      isSystem: false,
      createTime: { gte: since },
    },
  });
  if (inbound > 0) return null;
  return "未上榜用户暂只能给管理员发私信，或回复对方先发来的消息（上传任一级别成绩加入排行后不限）";
}
