// 用户组（2026-10-27）：可信用户组 / 低可信用户组——列表已合并进「玩家管理」
// （/admin/users?group=trusted|lowtrust 顶部筛选），本模块只保留三块共用能力：
//   ① 加组动作反查（admin_log / cheat_report → 加入时间 + 操作管理员）
//   ② joinTimesForGroup（组视图「最新加入在前」排序依据，供 getUserList 调用）
//   ③ getGroupBadges（导航 badge 信号：组人数 + 组内最新加入时刻，layout 每次渲染调用）
//
// 口径（与录像分拣 getUserTrustInfo 严格一致，勿单边漂移）：
// · 可信组 = user.trusted = 1（组内不检查 STNB 触发器，2026-10-24）
// · 低信任组 = 屏蔽史（名下有 status=0 录像）∪ 封禁史（user.status=-1）∪ low_trust_until 未到期
//   ——即 isLowTrustUser 三源（2026-10-27 扩展后口径）。
//
// 「加入时间 / 操作管理员」没有落库字段，从 admin_log 反查最新一条加组动作
// （user.setTrusted 加入 / user.setLowTrust / user.setStatus 封禁）；
// 探测器自动加入走 cheat_report（操作者=反作弊系统）。
// 建组前的历史屏蔽/封禁无法溯源，joinTime=null，排在列表尾部。

import { prisma } from "@/lib/db";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

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
export async function loadJoinLogs(): Promise<{
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

/** cheat_report：user → 最新命中时间（探测器自动加入低信任组的时间） */
export async function latestCheatReports(): Promise<Map<number, number>> {
  const rows = await prisma.$queryRawUnsafe<{ user: bigint; t: bigint }[]>(
    `SELECT user, MAX(create_time) t FROM cheat_report GROUP BY user`
  );
  return new Map(rows.map((r) => [N(r.user), N(r.t)]));
}

/** 组视图排序依据：全组 id → 各自加入时刻（trusted=加组日志；lowtrust=日志/探测器取有值者）。
 *  供 getUserList 组视图「最新加入在前」内存排序（加入时间无 SQL 列，只能反查后排序）。 */
export async function joinTimesForGroup(
  group: "trusted" | "lowtrust",
  ids: number[]
): Promise<{ groupJoinTimes: Map<number, number> }> {
  if (!ids.length) return { groupJoinTimes: new Map() };
  const idSet = new Set(ids);
  if (group === "trusted") {
    const { trustedJoin } = await loadJoinLogs();
    const m = new Map<number, number>();
    for (const [uid, v] of trustedJoin) if (idSet.has(uid)) m.set(uid, v.time);
    return { groupJoinTimes: m };
  }
  const [joinInfo, cheatTimes] = await Promise.all([loadJoinLogs(), latestCheatReports()]);
  const m = new Map<number, number>();
  for (const [uid, v] of joinInfo.lowJoin) if (idSet.has(uid)) m.set(uid, v.time);
  for (const [uid, t] of cheatTimes) if (idSet.has(uid) && !m.has(uid)) m.set(uid, t);
  return { groupJoinTimes: m };
}

// ---------- badge 查询（layout 每次渲染调用，必须轻） ----------

export async function getGroupBadges(): Promise<GroupBadges> {
  const t = Math.floor(Date.now() / 1000);
  const [trustedCount, lowCountRows, trustedMaxRows, lowMaxManualRows, lowMaxCheatRows] = await Promise.all([
    prisma.user.count({ where: { trusted: true } }),
    // 三源去重计数（同低信任组口径）
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
    // 低信任组「新动作」信号：手动加组 / 封禁（口径同 isLowTrustJoinLog；纯屏蔽史不可溯源不触发 badge）
    prisma.$queryRawUnsafe<{ m: bigint | null }[]>(
      `SELECT MAX(create_time) m FROM admin_log WHERE action IN ('user.setLowTrust','user.setStatus')
       AND (action = 'user.setLowTrust' OR detail LIKE '封禁玩家%')`
    ),
    prisma.$queryRawUnsafe<{ m: bigint | null }[]>(`SELECT MAX(create_time) m FROM cheat_report`),
  ]);
  return {
    trustedCount,
    lowTrustCount: N(lowCountRows[0]?.c),
    trustedMaxJoin: N(trustedMaxRows[0]?.m),
    lowTrustMaxJoin: Math.max(N(lowMaxManualRows[0]?.m), N(lowMaxCheatRows[0]?.m)),
  };
}
