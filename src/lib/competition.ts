// 比赛业务层（2026-11-13 张老师需求：前台「比赛」页 + 后台「比赛管理」）
//
// 口径备忘：
// · 状态不落库，由起止时间对 now 推导（未开始/进行中/已结束）；
// · 列表排序＝进行中 → 未开始 → 已结束（张老师 13:12 定）；同状态内：
//   进行中按结束时间升序（先结束的在前）、未开始按开始时间升序、已结束按结束时间倒序；
// · 比赛总量小（十场量级），列表整表取回内存排序 + 切页，避免 CASE WHEN 裸拼 SQL；
// · 比赛标识 code 创建时即生成，前台开始前显示「待定」；
// · 成绩采集为下一期口径：本期图表无数据源，渲染占位；全网统计「录像数量」恒 0。

import { prisma } from "@/lib/db";

export type CompetitionStatus = "upcoming" | "active" | "ended";

export const COMP_PAGE_SIZE = 5; // 张老师：一页最多同时显示 5 个比赛

export function compStatus(
  start: bigint | number,
  end: bigint | number,
  now: number
): CompetitionStatus {
  const s = Number(start);
  const e = Number(end);
  if (now < s) return "upcoming";
  if (now < e) return "active";
  return "ended";
}

const STATUS_ORDER: Record<CompetitionStatus, number> = { active: 0, upcoming: 1, ended: 2 };

// ---------- 展示格式化 ----------

/** 相对时长：X天X时X分 / X时X分 / X分（气泡倒计时与已结束相对时间共用） */
export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}时${m}分`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}

/** 已结束时刻展示：一天内相对（X时X分前），否则绝对（M月D日 HH:mm） */
export function fmtEndedAt(end: bigint | number, now: number): string {
  const e = Number(end);
  const diff = now - e;
  if (diff < 86400) return `${fmtDuration(Math.max(diff, 0))}前`;
  const d = new Date(e * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** 起止日期小标：11月11日 ~ 12月3日（跨年带年份） */
export function fmtDateRange(start: bigint | number, end: bigint | number): string {
  const s = new Date(Number(start) * 1000);
  const e = new Date(Number(end) * 1000);
  const f = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
  const year = s.getFullYear() === e.getFullYear() ? "" : `${s.getFullYear()}年`;
  return `(${year}${f(s)} ~ ${f(e)})`;
}

export const fmtPrize = (n: number): string => `¥${n.toLocaleString("en-US")}`;

/** 分配方案原文 → 气泡文本（每行一名次，逗号拼接；空行过滤） */
export function parsePrizePlan(plan: string): string[] {
  return plan
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 剩余时间气泡颜色分级（张老师 13:12 稿定）：一天以上绿 / 一小时内黄 / 10 分钟内玫瑰红 */
export function remainColor(sec: number): string {
  if (sec <= 600) return "#f92672";
  if (sec <= 3600) return "#fdc61a";
  return "#a6e22e";
}

// ---------- 比赛标识 ----------

const CODE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 6 位数字+大小写字母随机标识（创建时生成，唯一性靠重试） */
export function genCompCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export async function genUniqueCompCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = genCompCode();
    const hit = await prisma.competition.findFirst({ where: { code }, select: { id: true } });
    if (!hit) return code;
  }
  return `${Date.now().toString(36)}`.slice(-6); // 兜底：碰撞概率极低，仍保证可写
}

// ---------- 列表查询 ----------

export interface CompRow {
  id: string;
  name: string;
  shortName: string;
  status: CompetitionStatus;
  start: number;
  end: number;
  rules: string;
  creatorName: string;
  prizeTotal: number;
  prizeLines: string[];
  code: string;
  entryCount: number;
  joined: boolean; // 当前登录用户是否已报名
}

export interface CompPage {
  rows: CompRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 比赛列表：状态排序 → 内存切页。uid 传入时带「是否已报名」标记 */
export async function getCompetitionPage(page: number, uid?: number): Promise<CompPage> {
  const now = Math.floor(Date.now() / 1000);
  const all = await prisma.competition.findMany({
    orderBy: { startTime: "asc" },
  });

  // 报名数一次聚合
  const counts = await prisma.competitionEntry.groupBy({
    by: ["competitionId"],
    _count: { competitionId: true },
  });
  const countMap = new Map<string, number>(counts.map((c) => [c.competitionId.toString(), c._count.competitionId]));

  // 我的报名集合
  let mineSet = new Set<string>();
  if (uid) {
    const mine = await prisma.competitionEntry.findMany({
      where: { userId: BigInt(uid) },
      select: { competitionId: true },
    });
    mineSet = new Set(mine.map((m) => m.competitionId.toString()));
  }

  // 发起人姓名
  const creatorIds = [...new Set(all.map((c) => c.creatorId.toString()))];
  const creators = creatorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: creatorIds.map((s) => BigInt(s)) } },
        select: { id: true, chineseName: true },
      })
    : [];
  const nameMap = new Map(creators.map((u) => [u.id.toString(), u.chineseName]));

  const rows: CompRow[] = all.map((c) => {
    const cid = c.id.toString();
    return {
      id: cid,
      name: c.name,
      shortName: c.shortName,
      status: compStatus(c.startTime, c.endTime, now),
      start: Number(c.startTime),
      end: Number(c.endTime),
      rules: c.rules,
      creatorName: nameMap.get(c.creatorId.toString()) || `UID ${c.creatorId}`,
      prizeTotal: c.prizeTotal,
      prizeLines: parsePrizePlan(c.prizePlan),
      code: c.code,
      entryCount: countMap.get(cid) ?? 0,
      joined: mineSet.has(cid),
    };
  });

  // 排序：进行中 → 未开始 → 已结束（张老师 13:12 定）
  rows.sort((a, b) => {
    const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (d !== 0) return d;
    if (a.status === "active") return a.end - b.end; // 先结束的在前
    if (a.status === "upcoming") return a.start - b.start;
    return b.end - a.end; // 已结束：最近的在前
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / COMP_PAGE_SIZE));
  const p = Math.min(Math.max(page, 1), totalPages);
  return {
    rows: rows.slice((p - 1) * COMP_PAGE_SIZE, p * COMP_PAGE_SIZE),
    total,
    page: p,
    pageSize: COMP_PAGE_SIZE,
    totalPages,
  };
}

// ---------- 统计 ----------

export interface CompGlobalStats {
  competitions: number; // 比赛个数（全站）
  participants: number; // 参赛人数（去重用户）
  videos: number; // 录像数量（成绩采集下一期接入，恒 0）
  prizeTotal: number; // 累计奖金（全站总奖金之和）
}

export async function getCompGlobalStats(): Promise<CompGlobalStats> {
  const [competitions, participants, prizeAgg] = await Promise.all([
    prisma.competition.count(),
    prisma.competitionEntry.groupBy({ by: ["userId"], where: {} }).then((g) => g.length),
    prisma.competition.aggregate({ _sum: { prizeTotal: true } }),
  ]);
  return {
    competitions,
    participants,
    videos: 0, // TODO 成绩采集期接入：比赛局录像计数
    prizeTotal: prizeAgg._sum.prizeTotal ?? 0,
  };
}

export interface CompMyStats {
  joined: number; // 参加比赛次数（已报名数）
  bestRank: number | null; // 最高排名（成绩采集下一期接入）
  prize: number; // 累计奖金（成绩采集下一期接入）
}

export async function getCompMyStats(uid: number): Promise<CompMyStats> {
  const joined = await prisma.competitionEntry.count({ where: { userId: BigInt(uid) } });
  return { joined, bestRank: null, prize: 0 }; // TODO 成绩采集期接入：bestRank / prize
}
