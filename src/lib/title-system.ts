// 称号体系（2026-10-17 Phase 5 双体系，张老师定）
//
// 体系 A「军衔制」（默认）：总司令/大元帅/…/列兵 19 档 + 预备役。
//   大元帅~列兵按高级时间绝对阈值评定；总司令=雷界排行第一人（总计时间 TOP1）特判
//   （2026-10-19 张老师改口径，原 SUB30 绝对阈值；与旧体系「雷帝」同一判定源）——
//   定义在 config.ts（TITLES/TITLE_THRESHOLDS/TITLE_CONDITIONS）与 assess.ts（title()），
//   未登录与用户未设置偏好时固定渲染这套。
// 体系 B「旧版称号」：雷帝/雷圣/雷神(GG)/雷仙(mm)/状元/榜眼/…/童生 + 布衣，
//   移植 2008 版 Help/Title.asp 规则（oldtitle.ts 同源），阈值独立于军衔制。
//
// 渲染跟随**观看者**：每个用户在 user_info.title_pref 存自己的偏好（'m'/'c'），
// 服务端按当前会话解析体系后换算称号——同一页面不同观看者看到不同体系。
//
// 雷帝（雷界排行第一人）是相对排名，快照算不出——渲染旧体系时实时判 TOP1
//（总计时间第一名，缓存 60s，张老师 2026-10-17 拍板可接受）。
// 2026-10-19 起军衔制总司令与雷帝同一判定源（getThunderKingId）。

import { unstable_cache } from "next/cache";
import { prisma } from "./db";
import { OLD_TITLES } from "./config";
import { title as militaryTitle } from "./assess";

// ---------- 体系定义 ----------

export type TitleSystem = "m" | "c";

export const TITLE_SYSTEMS: { key: TitleSystem; name: string; desc: string }[] = [
  { key: "m", name: "军衔体系（2026版）", desc: "总司令 · 大元帅 · … · 列兵（19 级军阶）" },
  { key: "c", name: "人神界体系（2008版）", desc: "雷帝 · 雷圣 · 雷神 · … · 童生（2008 版科举称号）" },
];

export function parseTitleSystem(v: string | null | undefined): TitleSystem {
  return v === "c" ? "c" : "m";
}

// ---------- 旧版称号（经典体系）计算 ----------

const CLASSIC_COLOR: Record<string, string> = Object.fromEntries(
  OLD_TITLES.map((t) => [t.name, t.color])
);

export interface ClassicTitle {
  name: string;
  color: string;
}

/** 旧版称号按高级纪录 + 性别评定（移植 2008 Title.asp；布衣=未加入排行）
 *  @param expTimeMs 快照/当前高级成绩（毫秒，0=无成绩）
 *  @param ranked    是否在榜（快照行内 ranked；实时场景传 user.status===0）
 *  @param sex       1=GG 0=mm（雷神/雷仙分性别）
 *  @param isThunder帝 雷界排行第一人（实时判 TOP1，见 getThunderKingId） */
export function classicTitle(
  expTimeMs: number,
  ranked: boolean,
  sex: number,
  isFirst = false
): ClassicTitle {
  let name: string;
  if (isFirst) name = "雷帝";
  else if (!ranked || expTimeMs <= 0) name = "布衣";
  else {
    const s = expTimeMs / 1000;
    if (s < 50) name = "雷圣";
    else if (s < 60) name = sex ? "雷神" : "雷仙";
    else if (s < 61) name = "状元";
    else if (s < 63) name = "榜眼";
    else if (s < 66) name = "探花";
    else if (s < 70) name = "进士";
    else if (s < 80) name = "举人";
    else if (s < 90) name = "秀才";
    else if (s < 100) name = "书生";
    else name = "童生";
  }
  return { name, color: CLASSIC_COLOR[name] ?? "#666666" };
}

// ---------- 雷界第一人（旧体系「雷帝」+ 军衔制「总司令」） ----------

const fetchThunderKingId = unstable_cache(
  async (): Promise<number> => {
    // 雷界第一人 = 总计时间最小且账号正常（user.status=0）。
    // 不复用 queries.rankedOnly（会构成循环依赖：queries → title-system → queries），
    // 封禁黑名单量级数百、对本查询无影响——直接 JOIN user 表同义表达
    const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT s.id FROM user_scores s
      JOIN \`user\` u ON u.id = s.id AND u.status = 0
      WHERE s.sum_time > 0 ORDER BY s.sum_time ASC LIMIT 1
    `;
    return rows.length ? Number(rows[0].id) : 0;
  },
  ["thunder-king-id-v1"],
  { revalidate: 60 }
);

/** 当前雷界第一人 user id（总计时间最小者；0=无人）。
 *  旧体系「雷帝」与军衔制「总司令」（2026-10-19 改口径）渲染时实时判，共用本源 */
export async function getThunderKingId(): Promise<number> {
  return fetchThunderKingId();
}

// ---------- 观看者偏好解析 ----------

/** 当前会话观看者的称号体系（读 user_info.title_pref；未登录/未设置/读库失败 → 军衔制） */
export async function resolveTitleSystem(uid: number | null | undefined): Promise<TitleSystem> {
  if (!uid) return "m";
  try {
    const info = await prisma.userInfo.findUnique({
      where: { id: BigInt(uid) },
      select: { titlePref: true },
    });
    return parseTitleSystem(info?.titlePref);
  } catch {
    return "m";
  }
}

// ---------- 统一换算入口 ----------

export interface TitleDisplay {
  /** 体系标识（渲染端区分徽章/彩字） */
  system: TitleSystem;
  /** 称号名 */
  name: string;
  /** 军衔制无色（样式类驱动）；旧版称号带 2008 版配色 */
  color?: string;
}

/**
 * 按观看者体系把「高级成绩快照 + 是否在榜」换算为称号。
 * 军衔制走 assess.title（总司令=雷界第一人特判）；旧版走 classicTitle（含雷帝实时判定）。
 * 两者同一判定源 getThunderKingId（2026-10-19 起总司令与雷帝恒为同一人）。
 */
export async function resolveTitleDisplay(
  system: TitleSystem,
  expTimeMs: number,
  ranked: boolean,
  sex: number,
  userId: number
): Promise<TitleDisplay> {
  const king = await getThunderKingId();
  const isKing = king > 0 && king === userId;
  if (system === "c") {
    const t = classicTitle(expTimeMs, ranked, sex, isKing);
    return { system: "c", name: t.name, color: t.color };
  }
  // 军衔制：预备役=无高级成绩（2026-10-28 张老师改口径：即便未入排行/封禁，
  // 有高级成绩也按时间评定军衔——ranked 不再参与军衔制评定，只保留给旧版称号判布衣）
  if (expTimeMs <= 0) return { system: "m", name: "预备役" };
  return { system: "m", name: militaryTitle(expTimeMs, isKing) };
}

// ---------- 双体系 DTO 工厂（服务端换算点共用） ----------

/** 双体系称号对：m=军衔名（徽章渲染）；c=旧版称号（彩字渲染）。
 *  TitleBadge 收 {title, classic} 二选一按观看者体系渲染 */
export interface TitlePair {
  /** 军衔制称号名（'' = 不显示，如后台/异常） */
  m: string;
  /** 旧版称号（null = 未算/该场景不提供，回退军衔制） */
  c: { name: string; color: string } | null;
}

/**
 * dualTitle：单行「快照 → 双体系称号对」（雷帝/总司令判定由调用方一次性取 TOP1 后逐行传入；
 * 2026-10-19 起总司令=雷界第一人，两体系 TOP1 恒同一人）
 */
export function dualTitle(
  userId: number,
  expTime: number,
  ranked: boolean,
  sex: number,
  king: number
): TitlePair {
  const isKing = king > 0 && king === userId;
  return {
    // 军衔制：预备役=无高级成绩（2026-10-28 张老师改口径，ranked 不再参与军衔制评定）
    m: expTime <= 0 ? "预备役" : militaryTitle(expTime, isKing),
    c: classicTitle(expTime, ranked, sex, isKing),
  };
}

/** 服务端批量换算「快照 → 双体系称号对」（雷帝/总司令判定一次性取 TOP1；
 *  2026-10-19 起总司令=雷界第一人，两体系 TOP1 恒同一人）
 *
 * ⚠️ 返回**与传入行序严格对齐的数组**（2026-10-27 修复），不再返回 Map：
 * 旧 Map 以 userId 为键，同一用户多行（各带各的上传时刻快照——如个人主页录像区、
 * 评论区、BBS 楼层流）时后行覆盖前行，整批塌缩成同一称号（个人主页录像整页
 * 同一军衔的根因）。调用方一律 `dualTitles(rows)[i]` 按下标取本行称号。
 * 每行数据互不依赖（king 单次查询），无共享状态。 */
export async function dualTitles(
  rows: { userId: number; expTime: number; ranked: boolean; sex: number }[]
): Promise<TitlePair[]> {
  const king = await getThunderKingId();
  return rows.map((r) => dualTitle(r.userId, r.expTime, r.ranked, r.sex, king));
}
