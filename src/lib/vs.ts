// 玩家对战 PK 页（/vs/[id]）数据层（2026-11-09 张老师需求）。
// 左侧恒为发起者（当前登录用户），右侧为被挑战者；数据全部复用既有口径：
//   · 卡片/名次/成绩：getUserCard（与用户主页、侧栏卡片同源）
//   · 每 BV 最快时间：getUser3bvCollection（收集墙口径：status<>0，封禁连坐保留）
//   · 实力雷达：getRadarData（23 档显式名次档）
//
// 得分规则（张老师 2026-11-09 定，2026-11-10 23:50 改口径）：
//   「初中高级纪录每胜一局1/2/10分，BV每胜一局计1分，独有计0.25分」——
//   · 纪录 9 行（时间/3BV/s/STNB）：优者拿该级权重 REC_WEIGHT（初级1/中级2/高级10）；
//   · BV 格：每胜一局固定 1 分（BV_WIN_SCORE，不按级别加权）；
//   · 独有一律 0.25 分（纪录与 BV 同口径），平局各 0 分。
//   · 总得分 = 纪录得分 + 三级别 BV 得分。
//
// ⚠️ 本模块依赖 prisma / next/cache，仅可被服务端引用（页面/RSC），
//    不得进客户端 bundle（与 lib/queries 同一约束）。

import { getUserCard, type UserCardData } from "./usercard";
import { getUser3bvCollection, getLevel3bvRanges, getStnbProfiles, type BbvCell, type StnbProfile } from "./queries";
import { getRadarData, type RadarPoint } from "./radar";
import { LEVEL_MIN_3BV, UNREACHABLE_3BV, type VideoLevel } from "./config";
import { score3bvs, scoreTime } from "./format";
import { prisma } from "./db";

const VIDEO_LEVELS: VideoLevel[] = ["beg", "int", "exp"];
const LEVEL_AXIS_CN: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
/** 纪录计分权重（2026-11-10 22:02 张老师「计分规则」逐字口径）：
 *  初级时间/3BVs/STNB 每项 1 分，中级每项 2 分，高级每项 5 分。 */
const REC_WEIGHT: Record<string, number> = { beg: 1, int: 2, exp: 10 };
/** BV 格每胜一局固定 1 分（2026-11-10 23:50 张老师：BV 不按级别加权） */
const BV_WIN_SCORE = 1;
/** 独有固定 0.25 分（2026-11-10 23:00 张老师：不再按级别权重折算） */
const SOLO_SCORE = 0.25;

/** 格子归属：p1=左侧玩家胜 / p2=右侧玩家胜 / u1、u2=单方独有 / tie=平局 / none=双方都没有（空格） */
export type VsOutcome = "p1" | "p2" | "tie" | "u1" | "u2" | "none";

export interface VsCell {
  bv: number;
  out: VsOutcome;
  /** 双方该 BV 最快时间（毫秒；独有侧为 null） */
  t1: number | null;
  t2: number | null;
  /** 双方该 BV 最快成绩录像 id（0=无；2026-11-11 张老师：有录像的格子可点进录像页） */
  v1: number;
  v2: number;
}

export interface VsBand {
  lo: number;
  hi: number;
  /** 该段内全部格子（按 bv 升序；渲染时按五类归属重排：我胜/我独有/都没有/对方独有/对方胜） */
  cells: VsCell[];
  s1: number;
  s2: number;
}

export interface VsLevelPk {
  level: VideoLevel;
  bands: VsBand[];
  /** 收集 BV 数（双方） */
  cnt1: number;
  cnt2: number;
  total1: number;
  total2: number;
  /** 对抗格数（双有）/ 胜 / 平 / 独有 */
  contest: number;
  win1: number;
  win2: number;
  tie: number;
  u1: number;
  u2: number;
  /** 「都没有」空格数（含 0/1 与 50/52/53 补位空格，均不画成绩不计分） */
  none: number;
}

// 2026-11-10 20:46 张老师：去掉所有饼图（纪录比较 + 三个级别板块各一个），
// 故 VsPie 接口、扇区配色常量、各级饼图数据与记录胜/平计数一并移除；
// 格子归属配色集中在 page.tsx 的 CELL_BG / CELL_FG，不再有第二套配色来源。

export interface VsRecRow {
  label: string;
  s1: string;
  s2: string;
  mark: VsOutcome | "none";
  /** 双方该纪录对应录像 id（0=无；2026-11-11 张老师：纪录成绩格可点进录像页） */
  v1: number;
  v2: number;
}

export interface VsPlayer {
  id: number;
  name: string;
  en: string;
  sex: number;
  avatarUrl: string;
  /** 无头像（走默认图）：军衔制下按性别渲染军装默认头像（2026-11-11） */
  avatarIsDefault: boolean;
  militaryTitle: string;
  /** 旧版称号备选（TitleBadge classic 双体系渲染，与玩家卡片一致） */
  classicTitle: { name: string; color: string } | null;
  area: string;
  areaRank: number | null;
  natRank: number | null;
  scores: Record<string, { score: number | null }>;
  radar: RadarPoint[];
}

export interface VsData {
  p1: VsPlayer;
  p2: VsPlayer;
  levels: VsLevelPk[];
  /** 记录比拼行 + 记录得分 */
  recRows: VsRecRow[];
  rec1: number;
  rec2: number;
  /** BV 总分（三级别合计） */
  bv1: number;
  bv2: number;
  /** 战前预估评价：只看双方总 STNB，绝不碰 PK 记录/BV 得分（张老师 2026-11-10：不要剧透结果） */
  preComment: string;
  /** 战前评价色调（2026-11-10）：占优=adv 绿 / 不利=dis 玫瑰红 / 势均力敌=even 金 */
  preTone: PreTone;
  /** 赛后评价：按总得分相对差距 × 我方胜负，四档 + 平局兜底 */
  postComment: string;
}

/** 战前评价色调：adv=占优（绿）/ dis=不利（玫瑰红）/ even=势均力敌（金） */
export type PreTone = "adv" | "dis" | "even";

/** 战前预估（2026-11-10 18:08 张老师改口径）：改用**双方总 STNB 成绩**比较，
 *  不再看雷达（雷达是排位百分位，顶级玩家间饱和，判什么都一样）。
 *  相对差 = (高 - 低) / 高（与赛后评价同款分母）：
 *    ≤ 10% →「势均力敌的对抗」(even 金)
 *    ≤ 20% →「稍占上风的对抗」/「略处下风的对抗」(adv 绿 / dis 玫瑰红)
 *    > 20% →「毫无悬念的碾压」/「毫无胜算的对抗」(adv / dis)
 *  总 STNB 来自 STNB 榜「总计」列（三级历史最高之和，缺级＝0），与 PK 记录/BV
 *  得分不是一套口径，故不剧透结果。两边都无有效总 STNB 时不下判断，给中性档。 */
export function preMatchAssessment(s1: number, s2: number): { text: string; tone: PreTone } {
  const hi = Math.max(s1, s2);
  const lo = Math.min(s1, s2);
  if (hi <= 0) return { text: "势均力敌的对抗", tone: "even" };
  const diff = (hi - lo) / hi;
  // 以我方(p1)视角判定：s1 ≥ s2 即我方占优（含相等，相等必落 even 档）
  const mine = s1 >= s2;
  if (diff <= 0.1) return { text: "势均力敌的对抗", tone: "even" };
  if (diff <= 0.2) {
    return mine
      ? { text: "稍占上风的对抗", tone: "adv" }
      : { text: "略处下风的对抗", tone: "dis" };
  }
  return mine
    ? { text: "毫无悬念的碾压", tone: "adv" }
    : { text: "毫无胜算的对抗", tone: "dis" };
}

/** 赛后评价（2026-11-10 17:52 张老师终版四句）：相对差距 = (高分-低分)/高分，
 *  >=0.4 视为悬殊，否则视为接近；平局单独兜底。视角恒为「我方」（p1=登录者）。 */
export function postMatchComment(t1: number, t2: number): string {
  if (t1 === t2) return "棋逢对手，平分秋色！";
  const hi = Math.max(t1, t2);
  const lo = Math.min(t1, t2);
  const big = hi > 0 && (hi - lo) / hi >= 0.4;
  if (t1 > t2) return big ? "赢得太轻松了，还是换个对手吧！" : "双方势均力敌，你略胜一筹！";
  return big ? "毫无还手之力，还是换个对手吧！" : "可惜，就差一点点！";
}

function toVsPlayer(card: UserCardData, radar: RadarPoint[]): VsPlayer {
  return {
    id: card.id,
    name: card.chineseName,
    en: card.englishName,
    sex: card.sex,
    avatarUrl: card.avatarUrl,
    avatarIsDefault: card.avatarIsDefault,
    militaryTitle: card.militaryTitle,
    classicTitle: card.classicTitle,
    area: card.area,
    areaRank: card.areaPos,
    natRank: card.rank,
    scores: Object.fromEntries(
      Object.entries(card.scores).map(([k, v]) => [k, { score: v.score }])
    ),
    radar,
  };
}

/** 段划分（2026-11-10 21:13 张老师）：初级从 0 起整十段（0/1 低于下限，
 *  作为「都没有」空格补进首段，让首行也是 10 格）；中/高级从下限所在十位段起。 */
function bandsFor(level: VideoLevel, maxBv: number): [number, number][] {
  const bands: [number, number][] = [];
  if (level === "beg") {
    for (let s = 0; s <= maxBv; s += 10) bands.push([s, s + 9]);
  } else {
    const start = Math.floor(LEVEL_MIN_3BV[level] / 10) * 10;
    for (let s = start; s <= maxBv; s += 10) bands.push([s, s + 9]);
  }
  return bands;
}

function computeLevelPk(level: VideoLevel, b1: Map<number, BbvCell>, b2: Map<number, BbvCell>, range: { min: number; max: number } | undefined): VsLevelPk {
  // 格子全序列（2026-11-10 21:13 张老师）：初级区间补齐 0/1（低于下限）与
  // 50/52/53（数学不可达）——这些值不再跳过，而是画成「都没有」的空格，
  // 归到每行中间的「都没有」区域，用来把首段/末段尽量填满；它们不计分。
  // 中/高级无此类补位值，仍按 [min,max] 全整数序列。
  const dead = new Set(UNREACHABLE_3BV[level] ?? []);
  const all: number[] = [];
  if (range) {
    const lo = level === "beg" ? 0 : range.min;
    for (let b = lo; b <= range.max; b++) all.push(b);
  }
  // 兜底：区间缺失（level3bvRange 表缺行）时退回双方并集
  if (!all.length) {
    const union = [...new Set([...b1.keys(), ...b2.keys()])].sort((x, y) => x - y);
    all.push(...union);
  }
  const pk: VsLevelPk = {
    level, bands: [], cnt1: b1.size, cnt2: b2.size,
    total1: 0, total2: 0, contest: 0, win1: 0, win2: 0, tie: 0, u1: 0, u2: 0, none: 0,
  };
  for (const [lo, hi] of bandsFor(level, all[all.length - 1])) {
    const band: VsBand = { lo, hi, cells: [], s1: 0, s2: 0 };
    for (const bv of all) {
      if (bv < lo || bv > hi) continue;
      // 低于下限（初级 0/1）与数学不可达（初级 50/52/53）＝补位空格：
      // 强制按「都没有」处理，即使历史数据里偶然有该 BV 也不参与比拼/计分
      const blank = dead.has(bv) || bv < LEVEL_MIN_3BV[level];
      const c1 = blank ? null : b1.get(bv);
      const c2 = blank ? null : b2.get(bv);
      const t1 = c1?.bestTime ?? null;
      const t2 = c2?.bestTime ?? null;
      const v1 = c1?.bestVideo ?? 0;
      const v2 = c2?.bestVideo ?? 0;
      let out: VsOutcome;
      if (blank) { out = "none"; pk.none++; }
      else if (t1 !== null && t2 !== null) {
        pk.contest++;
        if (t1 < t2) { out = "p1"; pk.win1++; band.s1 += BV_WIN_SCORE; }
        else if (t2 < t1) { out = "p2"; pk.win2++; band.s2 += BV_WIN_SCORE; }
        else { out = "tie"; pk.tie++; } // 平局各 0 分（张老师定）
      } else if (t1 !== null) { out = "u1"; pk.u1++; band.s1 += SOLO_SCORE; }
      else if (t2 !== null) { out = "u2"; pk.u2++; band.s2 += SOLO_SCORE; }
      else { out = "none"; pk.none++; } // 双方都没有：空格，不计分
      band.cells.push({ bv, out, t1, t2, v1, v2 });
    }
    if (band.cells.length) pk.bands.push(band);
    pk.total1 += band.s1;
    pk.total2 += band.s2;
  }
  return pk;
}

/**
 * 组装 PK 全量数据。任一方玩家不存在返回 null（页面 notFound）。
 * 复杂度：两次 getUser3bvCollection（各一条窗口函数查询）+ 两次雷达数据 +
 * 一次 STNB 榜 60s 缓存全量数组读取（getStnbProfiles），与用户主页单页同量级，
 * 直接实时算、不做额外缓存（PK 页低频访问）。
 */
export async function getVsData(id1: number, id2: number): Promise<VsData | null> {
  const [card1, card2] = await Promise.all([getUserCard(id1), getUserCard(id2)]);
  if (!card1 || !card2) return null;

  const [col1, col2, radar1, radar2, ranges, stnbProfiles] = await Promise.all([
    getUser3bvCollection(id1),
    getUser3bvCollection(id2),
    // 没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组
    card1.hasVideos ? getRadarData(card1.scores) : Promise.resolve([]),
    card2.hasVideos ? getRadarData(card2.scores) : Promise.resolve([]),
    getLevel3bvRanges(),
    // 战前预估口径＝双方总 STNB；纪录板块三行 STNB 也取自同一份 60s 缓存
    getStnbProfiles([id1, id2]),
  ]);

  const levels = VIDEO_LEVELS.map((lv) => computeLevelPk(lv, col1[lv], col2[lv], ranges[lv]));

  // 各项纪录比拼（2026-11-10 22:02 张老师）：按级别分组，每组「时间 / 3BV/s / STNB」
  // 共 9 行；去掉原「总计时间 / 总计 3BV/s」两行（规则里没有总计项），STNB 取 STNB
  // 榜该级历史最高（0＝无有效成绩，显示「—」，数值越高越好，与 3BV/s 同向）。
  // 计分按 23:50 口径：纪录优者拿级别权重（1/2/10）、独有一律 0.25 分、平局各 0 分
  // （BV 格固定每胜 1 分，不按级别加权）
  const STNB_ZERO: StnbProfile = { beg: 0, int: 0, exp: 0, total: 0, videos: { beg: 0, int: 0, exp: 0 } };
  const stnb1 = stnbProfiles.get(id1) ?? STNB_ZERO;
  const stnb2 = stnbProfiles.get(id2) ?? STNB_ZERO;
  let rec1 = 0;
  let rec2 = 0;
  const recRows: VsRecRow[] = (["beg", "int", "exp"] as const).flatMap((lv) =>
    (["time", "3bvs", "stnb"] as const).map((order) => {
      const raw1 = order === "stnb" ? stnb1[lv] : card1.scores[`${lv}_${order}`]?.score ?? null;
      const raw2 = order === "stnb" ? stnb2[lv] : card2.scores[`${lv}_${order}`]?.score ?? null;
      // 0 / null 一律视为无成绩（STNB 榜 0＝该级无有效成绩，与旧真值判断同义）
      const v1 = raw1 && raw1 > 0 ? raw1 : null;
      const v2 = raw2 && raw2 > 0 ? raw2 : null;
      let mark: VsRecRow["mark"] = "none";
      if (v1 !== null && v2 !== null) {
        mark = v1 === v2 ? "tie" : order === "time" ? (v1 < v2 ? "p1" : "p2") : (v1 > v2 ? "p1" : "p2");
      } else if (v1 !== null) mark = "p1";
      else if (v2 !== null) mark = "p2";
      // 计分（23:50 张老师）：纪录优者拿该级权重 1/2/10、独有一律 0.25 分、平局各 0 分
      const w = REC_WEIGHT[lv];
      const score = v1 !== null && v2 !== null ? w : SOLO_SCORE;
      if (mark === "p1") rec1 += score;
      else if (mark === "p2") rec2 += score;
      const fmt = (v: number | null) => {
        if (v === null) return "—";
        if (order === "stnb") return v.toFixed(1); // 与 STNB 榜 / 录像详情页同为 1 位小数
        return (order === "time" ? scoreTime(v) : score3bvs(v)) || "—";
      };
      // 纪录对应录像 id（2026-11-11 张老师：纪录成绩格可点进录像页）：
      // time/3bvs 六项来自 user_scores 的 *_video 列（UserCardScore.videoId），
      // STNB 三行来自 user_stnb_best.best_video（getStnbProfiles.videos）
      const rec1v =
        order === "stnb" ? stnb1.videos[lv] : card1.scores[`${lv}_${order}`]?.videoId ?? 0;
      const rec2v =
        order === "stnb" ? stnb2.videos[lv] : card2.scores[`${lv}_${order}`]?.videoId ?? 0;
      return {
        label: `${LEVEL_AXIS_CN[lv]}${order === "time" ? "时间" : order === "3bvs" ? " 3BV/s" : " STNB"}`,
        s1: fmt(v1),
        s2: fmt(v2),
        mark,
        v1: rec1v,
        v2: rec2v,
      };
    })
  );

  const bv1 = levels.reduce((s, l) => s + l.total1, 0);
  const bv2 = levels.reduce((s, l) => s + l.total2, 0);
  const pre = preMatchAssessment(stnb1.total, stnb2.total);

  return {
    p1: toVsPlayer(card1, radar1),
    p2: toVsPlayer(card2, radar2),
    levels,
    recRows,
    rec1,
    rec2,
    bv1,
    bv2,
    preComment: pre.text,
    preTone: pre.tone,
    postComment: postMatchComment(rec1 + bv1, rec2 + bv2),
  };
}

// ---------- 渲染辅助（纯函数，供页面组件用） ----------

// ---------- 对决记录落库（2026-11-11 张老师定） ----------
// /vs/:id 页每次有效访问落一行 vs_duel（比分/结果为本次渲染快照）；
// 同一 (发起者, 被挑战者) 10 分钟窗口去重——刷新/反复打开不重复计数。
// 失败静默：统计缺行可接受，绝不能影响 PK 页渲染。

const N = (v: unknown): number => Number(v ?? 0);

export async function recordVsDuel(uid: number, targetId: number, s1: number, s2: number): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const recent = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM vs_duel
      WHERE user_id = ${BigInt(uid)} AND target_id = ${BigInt(targetId)}
        AND create_time >= ${now - 600}
    `;
    if (N(recent[0]?.n) > 0) return;
    await prisma.vsDuel.create({
      data: {
        userId: BigInt(uid),
        targetId: BigInt(targetId),
        s1,
        s2,
        result: s1 === s2 ? 0 : s1 > s2 ? 1 : 2,
        createTime: BigInt(now),
      },
    });
  } catch {
    /* ignore：对决统计缺一行可接受 */
  }
}
