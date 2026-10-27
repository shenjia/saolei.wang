// 用户组列表（2026-10-27 张老师需求）：可信用户组 / 低信任用户组两个后台列表页 + 导航 badge。
//
// 口径（与录像分拣 getUserTrustInfo 严格一致，勿单边漂移）：
// · 可信组 = user.trusted = 1（组内不检查 STNB 触发器，2026-10-24）
// · 低信任组 = 屏蔽史（名下有 status=0 录像）∪ 封禁史（user.status=-1）∪ low_trust_until 未到期
//   ——即 isLowTrustUser 三源（2026-10-27 扩展后口径）。
//
// 「加入时间 / 操作管理员」没有落库字段，从 admin_log 反查最新一条加组动作
// （user.setTrusted 加入 / user.setLowTrust / user.setStatus 封禁 / video.review|batchReview 屏蔽）；
// 探测器自动加入走 cheat_report（操作者=反作弊系统）。
// 建组前的历史屏蔽/封禁无法溯源，joinTime=null，排在列表尾部。

import { prisma } from "@/lib/db";
import { ADMIN_PAGESIZE } from "./data";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---------- 行结构 ----------

export interface GroupRow {
  id: number;
  chineseName: string;
  status: number;
  /** 低信任组：生效中的反作弊标记截止（0=非标记源） */
  lowTrustUntil: number;
  /** 加入时间（Unix 秒；无法溯源的历史行为 null） */
  joinTime: number | null;
  /** 操作管理员（探测器自动加入 = 「反作弊系统」；无法溯源 = null） */
  joinBy: string | null;
  /** 低信任来源（低信任组专用；可信组恒空数组） */
  sources: string[];
}

export interface GroupListResult {
  rows: GroupRow[];
  total: number;
  pageSize: number;
  page: number;
  /** 组内最新加入时间（全量行取 max，分页前算——供列表页标记已读 / 新行加亮基线） */
  maxJoin: number;
}

/** badge 信号（layout 每次渲染调用，必须轻）：组人数 + 组内最新加入时间 */
export interface GroupBadges {
  trustedCount: number;
  lowTrustCount: number;
  trustedMaxJoin: number;
  lowTrustMaxJoin: number;
}

// ---------- 加组动作反查 ----------

/** 是否「加入低信任组」动作（admin_log.detail 文案匹配）
 *  ⚠️ 只认 targetId=玩家 ID 的动作：user.setLowTrust（手动加组）/ user.setStatus（封禁）。
 *  video.review / video.batchReview 的屏蔽日志 targetId 是录像 ID，无法映射到玩家——
 *  纯屏蔽史入组的成员 joinTime 不可溯源（null，排列表尾部）。 */
function isLowTrustJoinLog(action: string, detail: string): boolean {
  if (action === "user.setLowTrust") return true; // 已加入低信任用户组
  if (action === "user.setStatus" && detail.startsWith("封禁玩家")) return true;
  return false;
}

/** admin_log 反查：user → 最新加组时间与操作管理员（两组合并一轮查询） */
async function loadJoinLogs(): Promise<{
  trustedJoin: Map<number, { time: number; adminId: number }>;
  lowJoin: Map<number, { time: number; adminId: number }>;
  adminIds: number[];
}> {
  // admin_log 全表仅百行级，按 action 前缀收窄后全量读入，内存归并
  const logs = await prisma.adminLog.findMany({
    where: {
      action: { in: ["user.setTrusted", "user.setLowTrust", "user.setStatus"] },
    },
    select: { user: true, targetId: true, action: true, detail: true, createTime: true },
    orderBy: { id: "asc" }, // 升序遍历，同 user 后写覆盖前写 = 最新
  });
  const trustedJoin = new Map<number, { time: number; adminId: number }>();
  const lowJoin = new Map<number, { time: number; adminId: number }>();
  for (const log of logs) {
    const uid = N(log.targetId);
    if (!uid) continue;
    if (log.action === "user.setTrusted" && log.detail.includes("已加入可信用户组")) {
      trustedJoin.set(uid, { time: N(log.createTime), adminId: N(log.user) });
    } else if (isLowTrustJoinLog(log.action, log.detail)) {
      lowJoin.set(uid, { time: N(log.createTime), adminId: N(log.user) });
    }
  }
  const adminIds = [...new Set([...trustedJoin.values(), ...lowJoin.values()].map((v) => v.adminId).filter(Boolean))];
  return { trustedJoin, lowJoin, adminIds };
}

/** admin id → 显示名 */
async function adminNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: ids.map(BigInt) } },
    select: { id: true, chineseName: true },
  });
  return new Map(rows.map((r) => [N(r.id), r.chineseName]));
}

/** cheat_report：user → 最新命中时间（探测器自动加入低信任组的时间） */
async function latestCheatReports(): Promise<Map<number, number>> {
  const rows = await prisma.$queryRawUnsafe<{ user: bigint; t: bigint }[]>(
    `SELECT user, MAX(create_time) t FROM cheat_report GROUP BY user`
  );
  return new Map(rows.map((r) => [N(r.user), N(r.t)]));
}

/** 统一排序：最新加入在前；无法溯源的历史行排最后（内部再按 id） */
function sortRows(rows: GroupRow[]) {
  rows.sort((a, b) => {
    if (a.joinTime === null && b.joinTime === null) return a.id - b.id;
    if (a.joinTime === null) return 1;
    if (b.joinTime === null) return -1;
    return b.joinTime - a.joinTime || b.id - a.id;
  });
}

// ---------- 列表查询 ----------

export async function getTrustedGroup(page: number, q?: string): Promise<GroupListResult> {
  const kw = (q ?? "").trim();
  // trusted 组极小（个位数～两位数），一次取全量后在内存分页
  const users = await prisma.user.findMany({ where: { trusted: true } });
  const { trustedJoin, adminIds } = await loadJoinLogs();
  const names = await adminNames(adminIds);

  const rows: GroupRow[] = [];
  for (const u of users) {
    const uid = N(u.id);
    // badge 基线口径：maxJoin 一律取全量（搜索过滤不拉低基线，否则 badge 误消）
    const j = trustedJoin.get(uid);
    if (kw && !(kw === String(uid) || u.chineseName.includes(kw))) continue;
    rows.push({
      id: uid,
      chineseName: u.chineseName,
      status: u.status,
      lowTrustUntil: 0,
      joinTime: j ? j.time : null,
      joinBy: j ? names.get(j.adminId) ?? `#${j.adminId}` : null,
      sources: [],
    });
  }
  sortRows(rows);
  const maxJoin = users.length
    ? Math.max(
        ...users.map((u) => trustedJoin.get(N(u.id))?.time ?? 0)
      )
    : 0;
  const start = (page - 1) * ADMIN_PAGESIZE;
  return { rows: rows.slice(start, start + ADMIN_PAGESIZE), total: rows.length, pageSize: ADMIN_PAGESIZE, page, maxJoin };
}

export async function getLowTrustGroup(page: number, q?: string): Promise<GroupListResult> {
  const kw = (q ?? "").trim();
  const t = Math.floor(Date.now() / 1000);
  // 三源合并（与 isLowTrustUser 同口径）：标记 / 封禁史 / 屏蔽史。量级百人，全量取回内存分页。
  const [flagged, banned, blockedUsers, joinInfo, cheatTimes] = await Promise.all([
    prisma.user.findMany({ where: { lowTrustUntil: { gt: BigInt(t) } }, select: { id: true } }),
    prisma.user.findMany({ where: { status: -1 }, select: { id: true } }),
    prisma.$queryRawUnsafe<{ user: bigint }[]>(`SELECT DISTINCT user FROM video WHERE status = 0`),
    loadJoinLogs(),
    latestCheatReports(),
  ]);

  const blockedIds = new Set(blockedUsers.map((r) => N(r.user)));
  const idSet = new Set<number>();
  for (const u of [...flagged, ...banned]) idSet.add(N(u.id));
  for (const uid of blockedIds) idSet.add(uid);
  // badge 基线口径：maxJoin 一律取全量（搜索过滤不拉低基线，否则 badge 误消）
  const allIds = [...idSet];

  let ids = allIds;
  let hits: { id: bigint }[] | null = null;
  if (kw) {
    // 搜索过滤在合并后的 id 集上做（数字=ID 精确，否则姓名包含）
    hits = await prisma.user.findMany({
      where: /^\d+$/.test(kw) ? { id: BigInt(kw) } : { chineseName: { contains: kw } },
      select: { id: true },
    });
    const hitSet = new Set(hits.map((h) => N(h.id)));
    ids = ids.filter((x) => hitSet.has(x));
  }
  // 全量最新加入时刻（不受搜索影响；日志/探测器时间取 max）
  const allMaxJoin = (() => {
    let m = 0;
    for (const uid of allIds) {
      m = Math.max(m, joinInfo.lowJoin.get(uid)?.time ?? 0, cheatTimes.get(uid) ?? 0);
    }
    return m;
  })();
  if (!ids.length) return { rows: [], total: 0, pageSize: ADMIN_PAGESIZE, page, maxJoin: allMaxJoin };

  const users = await prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } } });
  const uMap = new Map(users.map((u) => [N(u.id), u]));
  const { lowJoin, adminIds } = joinInfo;
  const names = await adminNames(adminIds);

  const rows: GroupRow[] = [];
  for (const uid of ids) {
    const u = uMap.get(uid);
    if (!u) continue;
    const flagUntil = N(u.lowTrustUntil);
    const sources: string[] = [];
    if (flagUntil > t) sources.push("反作弊标记");
    if (u.status === -1) sources.push("封禁史");
    if (blockedIds.has(uid)) sources.push("屏蔽录像");
    if (!sources.length) continue; // 搜索过滤兜底：三源全空不该出现
    // 加入时间优先级：管理员动作日志 > 探测器 cheat_report > 无法溯源（null）
    const jl = lowJoin.get(uid);
    const ct = cheatTimes.get(uid);
    let joinTime: number | null = null;
    let joinBy: string | null = null;
    if (jl) {
      joinTime = jl.time;
      joinBy = names.get(jl.adminId) ?? `#${jl.adminId}`;
    } else if (ct) {
      joinTime = ct;
      joinBy = "反作弊系统";
    }
    rows.push({
      id: uid,
      chineseName: u.chineseName,
      status: u.status,
      lowTrustUntil: flagUntil,
      joinTime,
      joinBy,
      sources,
    });
  }
  sortRows(rows);
  const start = (page - 1) * ADMIN_PAGESIZE;
  return { rows: rows.slice(start, start + ADMIN_PAGESIZE), total: rows.length, pageSize: ADMIN_PAGESIZE, page, maxJoin: allMaxJoin };
}

// ---------- badge 查询（layout 每次渲染调用，必须轻） ----------

export async function getGroupBadges(): Promise<GroupBadges> {
  const t = Math.floor(Date.now() / 1000);
  const [trustedCount, lowCountRows, trustedMaxRows, lowMaxRows] = await Promise.all([
    prisma.user.count({ where: { trusted: true } }),
    // 三源去重计数（同 getLowTrustGroup 口径）
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM (
         SELECT id FROM user WHERE low_trust_until > ? OR status = -1
         UNION
         SELECT DISTINCT user FROM video WHERE status = 0
       ) x`,
      t
    ),
    prisma.$queryRawUnsafe<{ m: bigint | null }[]>(
      `SELECT MAX(create_time) m FROM admin_log WHERE action = 'user.setTrusted' AND detail LIKE '%已加入可信用户组%'`
    ),
    // 低信任组「新动作」信号——⚠️ 只统计**组内成员**的加入时间（2026-10-27 修复：
    // 此前 MAX(cheat_report) 取全库，已移出/已解除的探测记录会推进 maxJoin，
    // 红点亮但组内无新行可看，还会把已读基线抬高成"幽灵时间"吞掉后续真新行的高亮）。
    // 手动加组/封禁日志与探测器命中都限定 target 在组员集内取 max（口径同 getLowTrustGroup allMaxJoin）。
    prisma.$queryRawUnsafe<{ m: bigint | null }[]>(
      `SELECT MAX(t) m FROM (
         SELECT MAX(l.create_time) t FROM admin_log l
         WHERE (l.action = 'user.setLowTrust' OR (l.action = 'user.setStatus' AND l.detail LIKE '封禁玩家%'))
           AND l.target_id IN (
             SELECT id FROM user WHERE low_trust_until > ? OR status = -1
             UNION SELECT DISTINCT user FROM video WHERE status = 0
           )
         GROUP BY l.target_id
         UNION ALL
         SELECT MAX(c.create_time) t FROM cheat_report c
         WHERE c.user IN (
           SELECT id FROM user WHERE low_trust_until > ? OR status = -1
           UNION SELECT DISTINCT user FROM video WHERE status = 0
         )
         GROUP BY c.user
       ) x`,
      t,
      t
    ),
  ]);
  return {
    trustedCount,
    lowTrustCount: N(lowCountRows[0]?.c),
    trustedMaxJoin: N(trustedMaxRows[0]?.m),
    lowTrustMaxJoin: N(lowMaxRows[0]?.m),
  };
}
