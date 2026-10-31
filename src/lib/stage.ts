// 首页「动态/录像」阶段筛选（2026-10-29 张老师定，整体替换原级别筛选）
//
// tabs 跟随**观看者**称号体系（与全站双体系渲染同架构）：
//   军衔体系观看者：全部 / 将帅 / 校尉 / 士兵
//   人神界体系观看者：全部 / 神界 / 人界
// 点选后按**作者行内快照**（news.exp_time/ranked、video.exp_time/ranked，发布当时值，
// 与行内军衔徽章同口径）过滤——筛选档与徽章永不打架。
//
// 分档口径（毫秒）：
//   将帅 = 少将及以上（0 < exp < 50000；总司令为雷界第一人，exp 必然 <35s，天然覆盖）
//   校尉 = 大校~少尉（50000 ≤ exp < 70000）
//   士兵 = 上士~列兵（exp ≥ 70000）∪ 预备役（exp = 0，张老师 10-29 定归入士兵）
//   神界 = 旧称号雷帝/雷圣/雷神/雷仙（ranked=1 且 0 < exp < 60000，张老师 10-29 定按旧称号划）
//   人界 = 其余（状元~童生、布衣、预备役）
//
// 纯模块：不 import prisma/@prisma/client，客户端组件可直接引用。
// 服务端过滤片段在 queries.ts（newsStageSqlCond / videoStageCond）。
// 2026-10-31 张老师报告档错位（张子豪 69.89 破纪录动态：徽章少尉、档在士兵）：
// 动态阶段筛选改按「有效评定时间」分档（快照与关联录像 real_time 取优，与徽章
// recordNewsExpTime 同口径），录像流此前的 VIDEO_PROMOTED_EXP_SQL 同理。

export type FeedStage = "" | "gen" | "col" | "sol" | "god" | "man";

/** 快照 exp_time 分档毫秒界（与 config.TITLE_THRESHOLDS 对应档一致，此处独立取值防连锁误改） */
export const STAGE_EXP = {
  /** 将帅上限 = 少将档（TITLE_THRESHOLDS[5]） */
  GENERAL_MAX: 50000,
  /** 校尉上限 = 少尉档（TITLE_THRESHOLDS[12]） */
  FIELD_MAX: 70000,
  /** 神界上限 = 雷仙档（旧称号 60s 线） */
  GOD_MAX: 60000,
} as const;

export const STAGE_KEYS: FeedStage[] = ["", "gen", "col", "sol", "god", "man"];

/** API/查询参数解析：非法值一律回「全部」 */
export function parseFeedStage(v: string | null | undefined): FeedStage {
  return (STAGE_KEYS as string[]).includes(v ?? "") ? ((v ?? "") as FeedStage) : "";
}

/** 军衔体系观看者的阶段 tabs（key 传 API stage 参数） */
export const STAGE_TABS_M: { key: FeedStage; label: string }[] = [
  { key: "", label: "全部" },
  { key: "gen", label: "将帅" },
  { key: "col", label: "校尉" },
  { key: "sol", label: "士兵" },
];

/** 人神界体系观看者的阶段 tabs */
export const STAGE_TABS_C: { key: FeedStage; label: string }[] = [
  { key: "", label: "全部" },
  { key: "god", label: "神界" },
  { key: "man", label: "人界" },
];
