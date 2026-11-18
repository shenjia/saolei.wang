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
import { dualTitles } from "./title-system";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

/** 新粉丝提醒合并窗口（秒）：窗口内再有人关注，不新增消息，只改写既有那条 */
export const FOLLOW_NOTICE_MERGE_WINDOW_SEC = 3600;

/** 关注上限（2026-11-19 00:18 张老师定，00:20 上限改 200、00:38 每元改 5 位）：
 *  每用户默认 30 人；每赞助 1 元 +5 位，封顶 200。口径=本人赞助合计
 *  （donate 表 amount 分求和 ÷100 元，与主页统计一致） */
export const FOLLOW_LIMIT_BASE = 30;
export const FOLLOW_LIMIT_MAX = 200;
/** 每赞助 1 元提升的关注席位 */
export const FOLLOW_LIMIT_PER_YUAN = 5;

/** 用户的关注上限（默认 30 + 赞助元数×5，封顶 200） */
export async function getFollowLimit(userId: number): Promise<number> {
  const agg = await prisma.donate.aggregate({
    where: { user: BigInt(userId) },
    _sum: { amount: true },
  });
  const donatedYuan = Math.floor(N(agg._sum?.amount) / 100);
  return Math.min(FOLLOW_LIMIT_BASE + donatedYuan * FOLLOW_LIMIT_PER_YUAN, FOLLOW_LIMIT_MAX);
}

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

/** 序列化黑名单（输入行数组 → 规范文本：每行一个 id，去重去空行。
 *  23:28 收紧：与 parseBlocklistIds 同一白名单 /^[1-9]\d{0,14}$/——
 *  20 位超长数字串此前会混进存储列（无害但脏），清洗源头统一 */
export function serializeBlocklist(ids: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of ids) {
    const s = raw.trim();
    if (!/^[1-9]\d{0,14}$/.test(s)) continue;
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

/** 批量关注/粉丝计数（列表页头部 + 主页统计行用）。
 *  today（2026-11-19 00:53 张老师）：今日新增（create_time ≥ 当日零点，与全站
 *  统计行绿括号「今日」口径一致），主页 StatRow today 参数直接可用 */
export async function followCounts(
  userId: number
): Promise<{ following: number; followers: number; followingToday: number; followersToday: number }> {
  const dayStart = Math.floor(Date.now() / 1000) - ((Math.floor(Date.now() / 1000) + 8 * 3600) % 86400);
  const [f1, f2, t1, t2] = await Promise.all([
    prisma.userFollow.count({ where: { follower: BigInt(userId) } }),
    prisma.userFollow.count({ where: { followee: BigInt(userId) } }),
    prisma.userFollow.count({ where: { follower: BigInt(userId), createTime: { gte: BigInt(dayStart) } } }),
    prisma.userFollow.count({ where: { followee: BigInt(userId), createTime: { gte: BigInt(dayStart) } } }),
  ]);
  return { following: f1, followers: f2, followingToday: t1, followersToday: t2 };
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
  // 关注上限（2026-11-19 00:18 张老师定）：默认 30，每赞助 1 元 +5 位封顶 200。
  // 满员返回红色气泡文案（前端 error 型 toast 即红色）。
  const count = await prisma.userFollow.count({ where: { follower: BigInt(followerId) } });
  const limit = await getFollowLimit(followerId);
  if (count >= limit) {
    return `你关注已达上限${limit}人，对本站赞助可提升上限（最多200）`;
  }
  const now = nowSec();
  await prisma.userFollow.create({
    data: { follower: BigInt(followerId), followee: BigInt(followeeId), createTime: now },
  });
  // 紧邻抵消（2026-11-19 00:13 张老师定）：先取关又关注——
  // 若上一条是本人对同一目标的取关动态，删除它并跳过本次关注动态（两条都消失）
  const offset = await cancelOffsettingNews(followerId, followeeId, NEWS_TYPE.UNFOLLOW);
  if (!offset) {
    // 关注动态（type=55，reference=被关注人）：个人主页动态 + 首页「关注」筛选可见
    await publishNews({
      type: NEWS_TYPE.FOLLOW,
      userId: followerId,
      reference: followeeId,
      createTime: N(now),
    });
  }
  await sendFollowNotice(followerId, followeeId);
  return null;
}

/**
 * 紧邻抵消判定（2026-11-19 00:13 张老师定）：本人在同一目标上的**最新一条**
 * 关注/取关动态若是 expectedType（紧邻、中间无本人对该目标的其他关注/取关动态），
 * 删除它并返回 true（调用方跳过发新动态——两条互相抵消）。
 * 时间序按 (create_time, id) 倒序取第一条；只比对同一 (user, reference) 对。
 */
async function cancelOffsettingNews(
  userId: number,
  reference: number,
  expectedType: number
): Promise<boolean> {
  const latest = await prisma.news.findFirst({
    where: {
      user: BigInt(userId),
      reference: BigInt(reference),
      type: { in: [NEWS_TYPE.FOLLOW, NEWS_TYPE.UNFOLLOW] },
    },
    orderBy: [{ createTime: "desc" }, { id: "desc" }],
    select: { id: true, type: true },
  });
  if (!latest || latest.type !== expectedType) return false;
  await prisma.news.delete({ where: { id: latest.id } });
  return true;
}

/** 取关。幂等：未关注直接成功。成功后发取关动态（type=56） */
export async function unfollowUser(followerId: number, followeeId: number): Promise<string | null> {
  if (followerId === followeeId) return "参数错误";
  const res = await prisma.userFollow.deleteMany({
    where: { follower: BigInt(followerId), followee: BigInt(followeeId) },
  });
  if (res.count > 0) {
    // 紧邻抵消（2026-11-19 00:13 张老师定）：先关注又取关——
    // 若上一条是本人对同一目标的关注动态，删除它并跳过本次取关动态
    const offset = await cancelOffsettingNews(followerId, followeeId, NEWS_TYPE.FOLLOW);
    if (!offset) {
      await publishNews({
        type: NEWS_TYPE.UNFOLLOW,
        userId: followerId,
        reference: followeeId,
      });
    }
  }
  return null;
}

/**
 * 黑名单提交联动清理（2026-11-18 23:28 张老师定）：
 * ① 从自己的关注列表移除黑名单中所有 id（单向：我不再关注被拉黑的人）；
 * ② 从黑名单中所有用户的关注列表移除自己（单向：被拉黑的人不再关注我）。
 * 均只删关注关系、不发取关动态（拉黑是管理动作，动态流刷屏无意义且暴露拉黑关系）。
 *
 * ⚠️ SQL 注入防线：uid 入参在写点统一走 parseBlocklistIds（/^\d+$/ 严格校验 +
 * 上限 1000），查询全部走 Prisma 参数化（BigInt 包装），绝不做字符串拼接。
 */
export function parseBlocklistIds(raw: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const s = line.trim();
    // 严格数字白名单：仅 1~15 位纯数字（首位非零），其余一律拒绝
    if (!/^[1-9]\d{0,14}$/.test(s)) continue;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.slice(0, 1000);
}

export async function applyBlocklistCleanup(
  ownerId: number,
  blockIds: number[]
): Promise<{ removedMine: number; removedTheirs: number }> {
  if (!blockIds.length) return { removedMine: 0, removedTheirs: 0 };
  const bigIds = blockIds.map(BigInt);
  // ① 我 → 黑名单用户的关注行（follower=我，followee∈黑名单）
  const r1 = await prisma.userFollow.deleteMany({
    where: { follower: BigInt(ownerId), followee: { in: bigIds } },
  });
  // ② 黑名单用户 → 我的关注行（follower∈黑名单，followee=我）
  const r2 = await prisma.userFollow.deleteMany({
    where: { follower: { in: bigIds }, followee: BigInt(ownerId) },
  });
  return { removedMine: r1.count, removedTheirs: r2.count };
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
 * 军衔（23:42 张老师：性别标记后显示军衔）：按被列用户当前成绩评定（title 经典备选齐带）。
 */
export interface FollowListRow {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  avatar: string;
  /** 关注时间（Unix 秒） */
  createTime: number;
  /** 军衔（当前成绩评定；TitleBadge 主渲染） */
  title: string;
  /** 旧版称号备选（观看者体系切换渲染；null=无） */
  classic: { name: string; color: string } | null;
}

/** 列表行装配：users 行 + user_scores/user 双查 → 军衔评定（两列表共用） */
async function assembleRows(
  rows: { followee: bigint; follower: bigint; createTime: bigint }[],
  side: "followee" | "follower"
): Promise<FollowListRow[]> {
  const ids = [...new Set(rows.map((r) => Number(side === "followee" ? r.followee : r.follower)))];
  if (!ids.length) return [];
  const [users, scores] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids.map(BigInt) } },
      select: { id: true, chineseName: true, englishName: true, sex: true, avatar: true, status: true },
    }),
    prisma.userScores.findMany({
      where: { id: { in: ids.map(BigInt) } },
      select: { id: true, expTime: true },
    }),
  ]);
  const um = new Map(users.map((u) => [N(u.id), u]));
  const expMap = new Map(scores.map((x) => [N(x.id), x.expTime ?? 0]));
  const pairs = await dualTitles(
    ids.map((id) => ({
      userId: id,
      expTime: expMap.get(id) ?? 0,
      ranked: (um.get(id)?.status ?? -1) === 0,
      sex: um.get(id)?.sex ?? 1,
    }))
  );
  const pairById = new Map(ids.map((id, i) => [id, pairs[i] ?? null]));
  return rows
    .map((r) => {
      const uid = Number(side === "followee" ? r.followee : r.follower);
      const u = um.get(uid);
      if (!u) return null;
      const p = pairById.get(uid) ?? null;
      return {
        id: uid,
        chineseName: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        avatar: u.avatar,
        createTime: N(r.createTime),
        title: p?.m ?? "",
        classic: p?.c ?? null,
      };
    })
    .filter((x): x is FollowListRow => x !== null);
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
  return { rows: await assembleRows(rows, "followee"), total };
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
  return { rows: await assembleRows(rows, "follower"), total };
}
