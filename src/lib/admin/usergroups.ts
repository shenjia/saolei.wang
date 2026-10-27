// 用户组列表（2026-10-27 张老师需求）：可信用户组 / 低信任用户组两个后台列表页 + 导航 badge。
//
// 口径：
// · 可信组 = user.trusted = 1（组内不检查 STNB 触发器，2026-10-24）
// · 低信任组 = 反作弊标记未到期 ∪ 屏蔽史（最近屏蔽时刻晚于人工移出时刻）
//   —— 详细定义与「为什么封禁账号不计入」见 src/lib/lowtrust.ts（与录像分拣 getUserTrustInfo 同源，
//   列表 / 详情页 / 分拣三处禁单边漂移）。
//   屏蔽 → 入组联动自 2026-10-28 起改为弹窗可选（默认加入；不加入则 ops.ts 写豁免），见 lowtrust.ts 头注。
//
// 「加入时间 / 操作管理员」没有落库字段，从 admin_log 反查最新一条加组动作
// （user.setTrusted 加入 / user.setLowTrust）；探测器自动加入走 cheat_report（操作者=反作弊系统）；
// 屏蔽史取该玩家最近一次被屏蔽的时刻与审核人（video.review_time / review_user）。
// 建组前的历史屏蔽无法溯源审核人时，joinBy=null。

import { prisma } from "@/lib/db";
import { loadBlockedHistory, lowTrustState, type LowTrustBlocked, type LowTrustState } from "@/lib/lowtrust";
import { ADMIN_PAGESIZE } from "./data";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---------- 行结构 ----------

export interface GroupRow {
  id: number;
  chineseName: string;
  status: number;
  /** 低信任组：反作弊标记截止（0=无标记；「标记到期」列用） */
  lowTrustUntil: number;
  /** 低信任组：名下独立屏蔽录像部数（含已豁免的，「同时解除屏蔽」文案用） */
  blockedCount: number;
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

// ---------- admin_log 反查 ----------

/** admin_log 反查：user → 最新加组时间与操作管理员（两组合并一轮查询） */
async function loadJoinLogs(): Promise<{
  trustedJoin: Map<number, { time: number; adminId: number }>;
  lowJoin: Map<number, { time: number; adminId: number }>;
}> {
  // admin_log 全表仅百行级，按 action 收窄后全量读入，内存归并
  const logs = await prisma.adminLog.findMany({
    where: { action: { in: ["user.setTrusted", "user.setLowTrust"] } },
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
    } else if (log.action === "user.setLowTrust") {
      lowJoin.set(uid, { time: N(log.createTime), adminId: N(log.user) });
    }
  }
  return { trustedJoin, lowJoin };
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

// ---------- 低信任组成员（列表与 badge 共用） ----------

interface LowTrustMember {
  id: number;
  chineseName: string;
  status: number;
  state: LowTrustState;
  blocked: LowTrustBlocked | null;
}

/** 全量低信任组成员（量级百人）：标记中 ∪ 有屏蔽史的候选集，再按豁免时刻逐人判定。
 *  封禁账号（status=-1）不计入（2026-10-27 张老师定）。 */
async function loadLowTrustMembers(): Promise<LowTrustMember[]> {
  const now = Math.floor(Date.now() / 1000);
  const [flagged, blockedMap] = await Promise.all([
    prisma.user.findMany({ where: { lowTrustUntil: { gt: BigInt(now) } }, select: { id: true } }),
    loadBlockedHistory(),
  ]);
  const ids = new Set<number>();
  for (const u of flagged) ids.add(N(u.id));
  for (const uid of blockedMap.keys()) ids.add(uid);
  if (!ids.size) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids].map((x) => BigInt(x)) }, status: { not: -1 } },
    select: { id: true, chineseName: true, status: true, lowTrustUntil: true, lowTrustExempt: true },
  });
  const members: LowTrustMember[] = [];
  for (const u of users) {
    const blocked = blockedMap.get(N(u.id)) ?? null;
    const state = lowTrustState(u, blocked, now);
    if (!state.member) continue;
    members.push({ id: N(u.id), chineseName: u.chineseName, status: u.status, state, blocked });
  }
  return members.sort((a, b) => b.id - a.id); // 最终排序在 getLowTrustGroup 按加入时间做
}

/** 成员加入时间/操作管理员：标记源取 admin_log 或探测器时间，屏蔽源取最近一次屏蔽的审核人 */
async function resolveJoinInfo(members: LowTrustMember[]): Promise<Map<number, { time: number; by: number | null }>> {
  const now = Math.floor(Date.now() / 1000);
  const flaggedIds = members.filter((m) => m.state.flagUntil > now).map((m) => m.id);
  const [logs, cheats] = await Promise.all([
    flaggedIds.length
      ? prisma.adminLog.findMany({
          where: { action: "user.setLowTrust", targetId: { in: flaggedIds.map(BigInt) } },
          select: { user: true, targetId: true, createTime: true },
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
    latestCheatReports(),
  ]);
  const logMap = new Map<number, { time: number; adminId: number }>();
  for (const l of logs) logMap.set(N(l.targetId), { time: N(l.createTime), adminId: N(l.user) });

  const out = new Map<number, { time: number; by: number | null }>();
  for (const m of members) {
    const cands: { time: number; by: number | null }[] = [];
    if (m.state.flagUntil > now) {
      const lg = logMap.get(m.id);
      if (lg) cands.push({ time: lg.time, by: lg.adminId });
      const ct = cheats.get(m.id) ?? 0;
      if (ct) cands.push({ time: ct, by: null }); // 探测器：by=null 显示「反作弊系统」
    }
    if (m.state.blockedLast > 0) {
      cands.push({ time: m.state.blockedLast, by: m.blocked?.lastUser || null });
    }
    if (!cands.length) {
      out.set(m.id, { time: 0, by: null });
      continue;
    }
    cands.sort((a, b) => b.time - a.time);
    out.set(m.id, cands[0]);
  }
  return out;
}

// ---------- 列表查询 ----------

export async function getTrustedGroup(page: number, q?: string): Promise<GroupListResult> {
  const kw = (q ?? "").trim();
  // trusted 组极小（个位数～两位数），一次取全量后在内存分页
  const users = await prisma.user.findMany({ where: { trusted: true } });
  const { trustedJoin } = await loadJoinLogs();
  const names = await adminNames([...trustedJoin.values()].map((v) => v.adminId).filter(Boolean));

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
      blockedCount: 0,
      joinTime: j ? j.time : null,
      joinBy: j ? names.get(j.adminId) ?? `#${j.adminId}` : null,
      sources: [],
    });
  }
  sortRows(rows);
  const maxJoin = users.length ? Math.max(...users.map((u) => trustedJoin.get(N(u.id))?.time ?? 0)) : 0;
  const start = (page - 1) * ADMIN_PAGESIZE;
  return { rows: rows.slice(start, start + ADMIN_PAGESIZE), total: rows.length, pageSize: ADMIN_PAGESIZE, page, maxJoin };
}

export async function getLowTrustGroup(page: number, q?: string): Promise<GroupListResult> {
  const kw = (q ?? "").trim();
  const members = await loadLowTrustMembers();
  const joinInfo = await resolveJoinInfo(members);

  // 操作管理员名（日志管理员 + 屏蔽审核人）
  const ids = new Set<number>();
  for (const v of joinInfo.values()) if (v.by) ids.add(v.by);
  const names = await adminNames([...ids]);

  // badge 基线口径：maxJoin 一律取全量（搜索过滤不拉低基线，否则 badge 误消）
  let allMaxJoin = 0;
  for (const m of members) allMaxJoin = Math.max(allMaxJoin, joinInfo.get(m.id)?.time ?? 0);

  const rows: GroupRow[] = [];
  for (const m of members) {
    if (kw && !(kw === String(m.id) || m.chineseName.includes(kw))) continue;
    const j = joinInfo.get(m.id);
    rows.push({
      id: m.id,
      chineseName: m.chineseName,
      status: m.status,
      lowTrustUntil: m.state.flagUntil,
      blockedCount: m.state.blockedCount,
      joinTime: j && j.time > 0 ? j.time : null,
      joinBy: j && j.time > 0 ? (j.by ? names.get(j.by) ?? `#${j.by}` : "反作弊系统") : null,
      sources: m.state.sources,
    });
  }
  sortRows(rows);
  const start = (page - 1) * ADMIN_PAGESIZE;
  return { rows: rows.slice(start, start + ADMIN_PAGESIZE), total: rows.length, pageSize: ADMIN_PAGESIZE, page, maxJoin: allMaxJoin };
}

// ---------- badge 查询（layout 每次渲染调用，必须轻） ----------

export async function getGroupBadges(): Promise<GroupBadges> {
  const [trustedCount, members, trustedMaxRows] = await Promise.all([
    prisma.user.count({ where: { trusted: true } }),
    loadLowTrustMembers(),
    prisma.$queryRawUnsafe<{ m: bigint | null }[]>(
      `SELECT MAX(create_time) m FROM admin_log WHERE action = 'user.setTrusted' AND detail LIKE '%已加入可信用户组%'`
    ),
  ]);
  // 低信任组「新动作」信号——只统计**组内成员**的加入时间（口径同 getLowTrustGroup 的 maxJoin）：
  // 已移出/已豁免的探测记录不能推进基线，否则红点亮但组内无新行可看。
  const joinInfo = await resolveJoinInfo(members);
  let lowTrustMaxJoin = 0;
  for (const m of members) lowTrustMaxJoin = Math.max(lowTrustMaxJoin, joinInfo.get(m.id)?.time ?? 0);

  return {
    trustedCount,
    lowTrustCount: members.length,
    trustedMaxJoin: N(trustedMaxRows[0]?.m),
    lowTrustMaxJoin,
  };
}
