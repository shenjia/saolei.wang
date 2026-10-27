// 低信任用户组口径（2026-10-27 张老师定稿，三处共用，禁单边漂移）
//
// 成员 = 反作弊标记未到期（user.low_trust_until）
//      ∪ 屏蔽史（名下存在**独立屏蔽**录像，且最近一次屏蔽时刻晚于人工移出时刻）
//
// · 屏蔽 → 入组是「可选联动」而非全自动（2026-10-28 张老师需求：录像处理与人处理
//   分开）：后台屏蔽录像弹窗带「是否将上传者加入低信任用户组」勾选（默认勾选）——
//   勾选走本文件屏蔽史推导自动入组；不勾由 ops.ts 在屏蔽后写 low_trust_exempt=now
//   豁免本次屏蔽（复用「人工移出」字段语义）。未带该参数的内部调用（脚本/删除预屏蔽
//   /恢复流程）维持旧行为：屏蔽史自动入组（从严）。本文件判定逻辑不受影响。
// · 封禁账号不再计入（2026-10-27 张老师定）：封禁账号不可能上传/打排名，留在组里只是噪音；
//   封禁状态在「账号状态」列与封禁列表照常可见。解封后若仍有屏蔽史，自然重新计入。
// · 人工移出（user.low_trust_exempt 记时刻）：「移出低信任用户组」清标记 + 记本次时刻；
//   屏蔽时刻早于该值的屏蔽录像不再作为入组依据，之后再有录像被屏蔽且管理员勾选「加入」
//   （屏蔽时刻更晚）会重新入组。
// · 屏蔽史只认「独立屏蔽」＝video.status=0 且 video.status_bak=0。
//   封禁连坐（status_bak=原状态）不算：解禁时会自动恢复，不该留下永久低信任。
// · 屏蔽时刻口径：COALESCE(review_time, create_time)——人工审核一定写 review_time，
//   历史迁移数据缺失时退回上传时间。
//
// 调用方：后台低信任组列表 / 玩家详情页处置面板 / 录像自动分拣 getUserTrustInfo。

import { prisma } from "./db";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export const LOW_TRUST_SOURCE = {
  FLAG: "反作弊标记",
  BLOCKED: "屏蔽录像",
} as const;

/** 某玩家的屏蔽史摘要 */
export interface LowTrustBlocked {
  /** 名下独立屏蔽录像部数（含已被豁免的，供处置面板文案用） */
  count: number;
  /** 最近一次屏蔽时刻（Unix 秒；0=无） */
  lastTime: number;
  /** 最近一次屏蔽的操作者（admin id；0=历史数据无记录） */
  lastUser: number;
}

/** 低信任判定结果（成员资格 + 各源明细） */
export interface LowTrustState {
  member: boolean;
  /** 反作弊标记截止（0=无标记） */
  flagUntil: number;
  /** 人工移出时刻（0=从未移出） */
  exemptAt: number;
  /** 名下独立屏蔽录像部数 */
  blockedCount: number;
  /** 计入成员资格的最近屏蔽时刻（≤exemptAt 时为 0＝已被豁免） */
  blockedLast: number;
  /** 来源标签，无源＝空数组（非成员） */
  sources: string[];
}

/** 屏蔽时刻（与 SQL 口径一致） */
function blockTime(v: { reviewTime: bigint | null; createTime: bigint }): number {
  return N(v.reviewTime) || N(v.createTime);
}

/** 把一批「独立屏蔽」录像聚合成 user → 屏蔽史 */
function aggregate(
  rows: { user: bigint; reviewTime: bigint | null; createTime: bigint; reviewUser: bigint | null }[]
): Map<number, LowTrustBlocked> {
  const map = new Map<number, LowTrustBlocked>();
  for (const r of rows) {
    const uid = N(r.user);
    const t = blockTime(r);
    const cur = map.get(uid);
    if (!cur) {
      map.set(uid, { count: 1, lastTime: t, lastUser: N(r.reviewUser) });
      continue;
    }
    cur.count += 1;
    if (t > cur.lastTime) {
      cur.lastTime = t;
      cur.lastUser = N(r.reviewUser);
    }
  }
  return map;
}

/** 全站屏蔽史（后台组列表 / badge 用；量级百人千行，内存聚合） */
export async function loadBlockedHistory(): Promise<Map<number, LowTrustBlocked>> {
  const rows = await prisma.video.findMany({
    where: { status: 0, statusBak: 0 },
    select: { user: true, reviewTime: true, createTime: true, reviewUser: true },
  });
  return aggregate(rows);
}

/** 单人屏蔽史（详情页 / 分拣用） */
export async function loadBlockedHistoryOf(uid: number | bigint): Promise<LowTrustBlocked | null> {
  const id = BigInt(uid);
  const rows = await prisma.video.findMany({
    where: { user: id, status: 0, statusBak: 0 },
    select: { user: true, reviewTime: true, createTime: true, reviewUser: true },
  });
  return aggregate(rows).get(Number(id)) ?? null;
}

/** 成员资格判定（纯函数；now 可显式传入，便于脚本/测试复算）
 *  封禁账号（status=-1）不算成员：上传入口另有封禁闸，且封禁状态在别处可见。
 *  sources 仍如实给出（详情页要展示「为什么曾经在组里」）。 */
export function lowTrustState(
  user:
    | { status?: number | null; lowTrustUntil?: bigint | number | null; lowTrustExempt?: bigint | number | null }
    | null
    | undefined,
  blocked: LowTrustBlocked | null | undefined,
  now: number = Math.floor(Date.now() / 1000)
): LowTrustState {
  const flagUntil = N(user?.lowTrustUntil);
  const exemptAt = N(user?.lowTrustExempt);
  const blockedLast = blocked && blocked.lastTime > exemptAt ? blocked.lastTime : 0;
  const sources: string[] = [];
  if (flagUntil > now) sources.push(LOW_TRUST_SOURCE.FLAG);
  if (blockedLast) sources.push(LOW_TRUST_SOURCE.BLOCKED);
  return {
    member: sources.length > 0 && user?.status !== -1,
    flagUntil,
    exemptAt,
    blockedCount: blocked?.count ?? 0,
    blockedLast,
    sources,
  };
}
