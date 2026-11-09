// 玩家对战 PK 页（/vs/[id]）数据层（2026-11-09 张老师需求）。
// 左侧恒为发起者（当前登录用户），右侧为被挑战者；数据全部复用既有口径：
//   · 卡片/名次/成绩：getUserCard（与用户主页、侧栏卡片同源）
//   · 每 BV 最快时间：getUser3bvCollection（收集墙口径：status<>0，封禁连坐保留）
//   · 实力雷达：getRadarData（23 档显式名次档）
//
// 得分规则（张老师 2026-11-09 定）：
//   · 同一 3BV 双方都有纪录：快者得 1.00 分，同毫秒平局各 0 分
//   · 只有一方有的 3BV（独有）：该方得 0.25 分
//   · 各项记录比拼（4 级别 × 时间/3BV/s）同规则计分
//   · 总得分 = 记录得分 + 三级别 BV 得分
//
// ⚠️ 本模块依赖 prisma / next/cache，仅可被服务端引用（页面/RSC），
//    不得进客户端 bundle（与 lib/queries 同一约束）。

import { getUserCard, type UserCardData } from "./usercard";
import { getUser3bvCollection, type BbvCell } from "./queries";
import { getRadarData, type RadarPoint } from "./radar";
import {
  LEVELS,
  LEVEL_MIN_3BV,
  type VideoLevel,
} from "./config";
import { score3bvs, scoreTime } from "./format";

const VIDEO_LEVELS: VideoLevel[] = ["beg", "int", "exp"];
const LEVEL_CN: Record<VideoLevel, string> = { beg: "初级", int: "中级", exp: "高级" };
const LEVEL_AXIS_CN: Record<string, string> = { beg: "初级", int: "中级", exp: "高级", sum: "总计" };

/** 格子归属：p1=左侧玩家胜 / p2=右侧玩家胜 / u1、u2=单方独有 / tie=平局 */
export type VsOutcome = "p1" | "p2" | "tie" | "u1" | "u2";

export interface VsCell {
  bv: number;
  out: VsOutcome;
  /** 双方该 BV 最快时间（毫秒；独有侧为 null） */
  t1: number | null;
  t2: number | null;
}

export interface VsBand {
  lo: number;
  hi: number;
  /** 该段内全部格子（按 bv 升序；渲染时按归属拆左/中/右三组） */
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
}

export interface VsRecRow {
  label: string;
  s1: string;
  s2: string;
  mark: VsOutcome | "none";
}

export interface VsPlayer {
  id: number;
  name: string;
  en: string;
  sex: number;
  avatarUrl: string;
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
}

function toVsPlayer(card: UserCardData, radar: RadarPoint[]): VsPlayer {
  return {
    id: card.id,
    name: card.chineseName,
    en: card.englishName,
    sex: card.sex,
    avatarUrl: card.avatarUrl,
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

/** 段划分：初级首段 2-9（下限 2 个位数不满十），中/高级从下限所在十位段起 */
function bandsFor(level: VideoLevel, maxBv: number): [number, number][] {
  const bands: [number, number][] = [];
  if (level === "beg") {
    bands.push([LEVEL_MIN_3BV.beg, 9]);
    for (let s = 10; s <= maxBv; s += 10) bands.push([s, s + 9]);
  } else {
    const start = Math.floor(LEVEL_MIN_3BV[level] / 10) * 10;
    for (let s = start; s <= maxBv; s += 10) bands.push([s, s + 9]);
  }
  return bands;
}

function computeLevelPk(level: VideoLevel, b1: Map<number, BbvCell>, b2: Map<number, BbvCell>): VsLevelPk {
  const all = [...new Set([...b1.keys(), ...b2.keys()])].sort((x, y) => x - y);
  const maxBv = all.length ? all[all.length - 1] : LEVEL_MIN_3BV[level];
  const pk: VsLevelPk = {
    level, bands: [], cnt1: b1.size, cnt2: b2.size,
    total1: 0, total2: 0, contest: 0, win1: 0, win2: 0, tie: 0, u1: 0, u2: 0,
  };
  for (const [lo, hi] of bandsFor(level, maxBv)) {
    const band: VsBand = { lo, hi, cells: [], s1: 0, s2: 0 };
    for (const bv of all) {
      if (bv < lo || bv > hi) continue;
      const t1 = b1.get(bv)?.bestTime ?? null;
      const t2 = b2.get(bv)?.bestTime ?? null;
      let out: VsOutcome;
      if (t1 !== null && t2 !== null) {
        pk.contest++;
        if (t1 < t2) { out = "p1"; pk.win1++; band.s1 += 1; }
        else if (t2 < t1) { out = "p2"; pk.win2++; band.s2 += 1; }
        else { out = "tie"; pk.tie++; } // 平局各 0 分（张老师定）
      } else if (t1 !== null) { out = "u1"; pk.u1++; band.s1 += 0.25; }
      else { out = "u2"; pk.u2++; band.s2 += 0.25; }
      band.cells.push({ bv, out, t1, t2 });
    }
    if (band.cells.length) pk.bands.push(band);
    pk.total1 += band.s1;
    pk.total2 += band.s2;
  }
  return pk;
}

/**
 * 组装 PK 全量数据。任一方玩家不存在返回 null（页面 notFound）。
 * 复杂度：两次 getUser3bvCollection（各一条窗口函数查询）+ 两次雷达数据，
 * 与用户主页单页同量级，直接实时算、不做缓存（PK 页低频访问）。
 */
export async function getVsData(id1: number, id2: number): Promise<VsData | null> {
  const [card1, card2] = await Promise.all([getUserCard(id1), getUserCard(id2)]);
  if (!card1 || !card2) return null;

  const [col1, col2, radar1, radar2] = await Promise.all([
    getUser3bvCollection(id1),
    getUser3bvCollection(id2),
    // 没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组
    card1.hasVideos ? getRadarData(card1.scores) : Promise.resolve([]),
    card2.hasVideos ? getRadarData(card2.scores) : Promise.resolve([]),
  ]);

  const levels = VIDEO_LEVELS.map((lv) => computeLevelPk(lv, col1[lv], col2[lv]));

  // 各项记录比拼（4 级别 × 时间/3BV/s）：与 BV 同规则计分（胜 1.00 / 独有 0.25 / 平 0）
  let rec1 = 0;
  let rec2 = 0;
  const recRows: VsRecRow[] = (["time", "3bvs"] as const).flatMap((order) =>
    (LEVELS as readonly string[]).map((lv) => {
      const v1 = card1.scores[`${lv}_${order}`]?.score ?? null;
      const v2 = card2.scores[`${lv}_${order}`]?.score ?? null;
      let mark: VsRecRow["mark"] = "none";
      if (v1 && v2) {
        mark = v1 === v2 ? "tie" : order === "time" ? (v1 < v2 ? "p1" : "p2") : v1 > v2 ? "p1" : "p2";
      } else if (v1) mark = "p1";
      else if (v2) mark = "p2";
      if (mark === "p1") rec1 += v1 && v2 ? 1 : 0.25;
      else if (mark === "p2") rec2 += v1 && v2 ? 1 : 0.25;
      const fmt = (v: number | null) => (order === "time" ? scoreTime(v) : score3bvs(v)) || "—";
      return {
        label: `${LEVEL_AXIS_CN[lv] ?? lv}${order === "time" ? "时间" : " 3BV/s"}`,
        s1: fmt(v1),
        s2: fmt(v2),
        mark,
      };
    })
  );

  return {
    p1: toVsPlayer(card1, radar1),
    p2: toVsPlayer(card2, radar2),
    levels,
    recRows,
    rec1,
    rec2,
    bv1: levels.reduce((s, l) => s + l.total1, 0),
    bv2: levels.reduce((s, l) => s + l.total2, 0),
  };
}

// ---------- 渲染辅助（纯函数，供页面组件用） ----------
