// 关注系统核心逻辑（2026-11-18 张老师需求，五点一揽子）
// ① 关注/取关 + 关注动态（news type 55/56）
// ② 新粉丝系统消息：单人「XXX 关注了你。（去查看）」；窗口内多人合并
//    「XXX等x人关注了你。（去查看）」——查看前只保留一条未读合并消息
// ③ 黑名单：每行一个 id，四个闸口（发消息/评论录像/回复文章/关注）统一 parseBlocklist
//
// 本文件服务端专用（prisma）；hover 按钮等客户端组件走 /api/follow 路由。

import { prisma } from "./db";
import { publishNews } from "./news";
import { NEWS_TYPE } from "./config";
import { sendSystemMessage } from "./message";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

/** 新粉丝提醒合并窗口（秒）：窗口内再有人关注，不新增消息，只改写既有那条 */
export const FOLLOW_NOTICE_MERGE_WINDOW_SEC = 3600;

/** 合并消息锚点（contains 匹配用）：同时命中旧「（去查看）」与新「查看[/url]」两形态 */
const FOLLOW_NOTICE_ANCHOR = "关注了你。";

/** 解析黑名单文本 → id 集合（每行一个数字 id；脏行忽略） */
export function parseBlocklist(raw: string): Set<number> {
  const out = new Set<number>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const id = parseInt(line.trim(), 10);
    if (Number.isFinite(id) && id > 0) out.add(id);
  }
  return out;
}

/** 序列化黑名单（输入行数组 → 规范文本：每行一个 id，去重去空行） */
export function serializeBlocklist(ids: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of ids) {
    const s = raw.trim();
    if (!/^\d+$/.test(s) || s === "0") continue;
    if (seen.has(s)) continue;
    seen.add(s);
    lines.push(s);
  }
  return lines.join("\n");
}

/** target 是否在 owner 的黑名单内 */
export async function isBlocked(ownerId: number, targetId: number): Promise<boolean> {
  if (ownerId === targetId) return false;
  const row = await prisma.user.findUnique({
    where: { id: BigInt(ownerId) },
    select: { followBlocklist: true },
  });
  if (!row) return false;
  return parseBlocklist(row.followBlocklist).has(targetId);
}

/**
 * 黑名单闸口检查：owner=被操作资源的属主（收信人/录像楼主/文章楼主/被关注人），
 * actor=发起者。命中返回给用户看的文案，null=放行。
 * 四个入口（发消息/评论录像/回复文章/关注）共用同一文案口径。
 */
export async function blocklistReject(ownerId: number, actorId: number): Promise<string | null> {
  if (!(await isBlocked(ownerId, actorId))) return null;
  return "对方已将你加入黑名单，无法进行此操作";
}

export async function isFollowing(followerId: number, followeeId: number): Promise<boolean> {
  if (!followerId || !followeeId || followerId === followeeId) return false;
  const row = await prisma.userFollow.findUnique({
    where: { follower_followee: { follower: BigInt(followerId), followee: BigInt(followeeId) } },
    select: { id: true },
  });
  return !!row;
}

/** 关注状态批量查询：viewer 对 targets 的已关注态（hover 按钮初始态用） */
export async function followingSet(
  followerId: number,
  targetIds: number[]
): Promise<Set<number>> {
  const out = new Set<number>();
  if (!followerId || !targetIds.length) return out;
  const rows = await prisma.userFollow.findMany({
    where: { follower: BigInt(followerId), followee: { in: targetIds.filter((t) => t && t !== followerId).map(BigInt) } },
    select: { followee: true },
  });
  for (const r of rows) out.add(N(r.followee));
  return out;
}

/** 批量关注/粉丝计数（列表页头部 + 主页统计行用） */
export async function followCounts(userId: number): Promise<{ following: number; followers: number }> {
  const [f1, f2] = await Promise.all([
    prisma.userFollow.count({ where: { follower: BigInt(userId) } }),
    prisma.userFollow.count({ where: { followee: BigInt(userId) } }),
  ]);
  return { following: f1, followers: f2 };
}

/**
 * 关注动作。闸门顺序：不能关注自己 → 黑名单 → 幂等（已关注直接成功）。
 * 成功：落 user_follow + 发关注动态（type 55）+ 新粉丝提醒（合并窗口）。
 */
export async function followUser(followerId: number, followeeId: number): Promise<string | null> {
  if (followerId === followeeId) return "不能关注自己";
  const target = await prisma.user.findUnique({
    where: { id: BigInt(followeeId) },
    select: { id: true, status: true },
  });
  if (!target) return "用户不存在";
  // 封禁用户不可被关注（status 语义：0 正常 / 非 0 封禁，与用户主页红字口径一致）
  if (target.status !== 0) return "该用户已被封禁";
  const blocked = await blocklistReject(followeeId, followerId);
  if (blocked) return blocked;
  // 幂等：已关注再点不报错、不重复发动态/消息（upsert 语义前置成显式判）
  const dup = await prisma.userFollow.findUnique({
    where: { follower_followee: { follower: BigInt(followerId), followee: BigInt(followeeId) } },
    select: { id: true },
  });
  if (dup) return null;
  const now = nowSec();
  await prisma.userFollow.create({
    data: { follower: BigInt(followerId), followee: BigInt(followeeId), createTime: now },
  });
  // 关注动态（type=55，reference=被关注人）：个人主页 NEWS_FEED_EXCLUDED 不显示，
  // 仅首页「关注的人的动态」聚合筛选可见
  await publishNews({
    type: NEWS_TYPE.FOLLOW,
    userId: followerId,
    reference: followeeId,
    createTime: N(now),
  });
  await sendFollowNotice(followerId, followeeId);
  return null;
}

/** 取关。幂等：未关注直接成功。成功后发取关动态（type=56） */
export async function unfollowUser(followerId: number, followeeId: number): Promise<string | null> {
  if (followerId === followeeId) return "参数错误";
  const res = await prisma.userFollow.deleteMany({
    where: { follower: BigInt(followerId), followee: BigInt(followeeId) },
  });
  if (res.count > 0) {
    await publishNews({
      type: NEWS_TYPE.UNFOLLOW,
      userId: followerId,
      reference: followeeId,
    });
  }
  return null;
}

/**
 * 新粉丝提醒（需求 3）：
 * 提醒开关（user.follow_notify_disabled，默认开=提醒）关闭时不发。
 * 窗口（1h）内已有未读的「关注了你」合并消息 → 改写为「XXX等x人关注了你。查看」，
 * 不新增行；窗口外或没有未读合并消息 → 新发「XXX 关注了你。查看」。
 * 「查看」为站内链接标记（[url /followers]查看[/url]），消息列表渲染成绿色链接
 * （22:50 张老师定：与「回复」同款形态），点击跳我的粉丝列表。已读消息不合并。
 */
async function sendFollowNotice(followerId: number, followeeId: number): Promise<void> {
  const owner = await prisma.user.findUnique({
    where: { id: BigInt(followeeId) },
    select: { followNotifyDisabled: true },
  });
  if (owner?.followNotifyDisabled) return;
  const followerName =
    (await prisma.user.findUnique({ where: { id: BigInt(followerId) }, select: { chineseName: true } }))
      ?.chineseName ?? "";
  const now = N(nowSec());
  const viewLink = "[url /followers]查看[/url]";
  const latest = await prisma.message.findFirst({
    where: {
      toUser: BigInt(followeeId),
      isSystem: true,
      content: { contains: FOLLOW_NOTICE_ANCHOR },
      createTime: { gte: BigInt(now - FOLLOW_NOTICE_MERGE_WINDOW_SEC) },
    },
    orderBy: { id: "desc" },
    select: { id: true, isRead: true, content: true, createTime: true },
  });
  if (latest && !latest.isRead) {
    // 未读合并消息存在：改写人数与首个名字（首名保持窗口首条关注者不变）。
    // 两种既有形态都要解析基名：① 已合并「XXX等N人关注了你…」；② 单人「XXX 关注了你…」
    const multi = latest.content.match(/^(.+?)等(\d+)人关注了你/);
    const single = multi ? null : latest.content.match(/^(.+?) 关注了你/);
    const firstName = multi ? multi[1] : single ? single[1] : followerName;
    const count = (multi ? parseInt(multi[2], 10) : 1) + 1;
    await prisma.message.update({
      where: { id: latest.id },
      data: { content: `${firstName}等${count}人关注了你。${viewLink}`, updateTime: nowSec() },
    });
    return;
  }
  await sendSystemMessage(followeeId, `${followerName} 关注了你。${viewLink}`);
}

/**
 * 关注列表行（粉丝/关注列表页与聚合查询共用）：按关注时间倒序，时间口径=关注动作时间。
 */
export interface FollowListRow {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  avatar: string;
  /** 关注时间（Unix 秒） */
  createTime: number;
}

/** 我的关注列表（按时间倒序分页） */
export async function getFollowingList(
  userId: number,
  page: number,
  pageSize: number
): Promise<{ rows: FollowListRow[]; total: number }> {
  const where = { follower: BigInt(userId) };
  const [rows, total] = await Promise.all([
    prisma.userFollow.findMany({
      where,
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.userFollow.count({ where }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.followee) } },
    select: { id: true, chineseName: true, englishName: true, sex: true, avatar: true },
  });
  const um = new Map(users.map((u) => [N(u.id), u]));
  return {
    rows: rows
      .map((r) => {
        const u = um.get(N(r.followee));
        return u
          ? {
              id: N(u.id),
              chineseName: u.chineseName,
              englishName: u.englishName,
              sex: u.sex,
              avatar: u.avatar,
              createTime: N(r.createTime),
            }
          : null;
      })
      .filter((x): x is FollowListRow => x !== null),
    total,
  };
}

/** 我的粉丝列表（按时间倒序分页） */
export async function getFollowerList(
  userId: number,
  page: number,
  pageSize: number
): Promise<{ rows: FollowListRow[]; total: number }> {
  const where = { followee: BigInt(userId) };
  const [rows, total] = await Promise.all([
    prisma.userFollow.findMany({
      where,
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.userFollow.count({ where }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.follower) } },
    select: { id: true, chineseName: true, englishName: true, sex: true, avatar: true },
  });
  const um = new Map(users.map((u) => [N(u.id), u]));
  return {
    rows: rows
      .map((r) => {
        const u = um.get(N(r.follower));
        return u
          ? {
              id: N(u.id),
              chineseName: u.chineseName,
              englishName: u.englishName,
              sex: u.sex,
              avatar: u.avatar,
              createTime: N(r.createTime),
            }
          : null;
      })
      .filter((x): x is FollowListRow => x !== null),
    total,
  };
}
