// 后台重查询缓存（2026-09-24）
//
// 为什么需要：分布类统计（军衔 / 地区 / 软件 / 时段 / 3BV 分档）与纪录演变曲线都要
// 全表扫描 30 万行级大表；后台每次刷新都重算，既慢又白占数据库连接
// （本机 MySQL 与其它项目共用实例，连接池紧张时会出现 P1017 断连）。
//
// 这些数据都是「历史累积分布」，分钟级变化可忽略，因此统一缓存 10 分钟：
// 首次访问仍实时查询，之后 10 分钟内秒开。
//
// 注意：缓存键带版本前缀，改口径时记得升 key 版本丢弃旧缓存。

import { unstable_cache } from "next/cache";
import { registerPreheat } from "../preheat";
import {
  getAnomalies,
  getAreaCounts,
  getBoardCounts,
  getCurrentRecords,
  getHourlyCounts,
  getLevelCounts,
  getNfCounts,
  getOverview,
  getRecordCurve,
  getSexCounts,
  getSoftwareCounts,
  getTitlePrefCounts,
  getTrend,
  getWeekdayCounts,
} from "./stats";

export const ADMIN_CACHE_TTL = 600; // 10 分钟

const cache = <T>(fn: () => Promise<T>, key: string, ttl = ADMIN_CACHE_TTL) =>
  unstable_cache(fn, [`admin-v1-${key}`], { revalidate: ttl, tags: ["admin-stats"] });

/** 仪表盘软件分布 + 称号体系偏好（2026-10-21 加 titlePrefs，载荷结构变更 → key 升 v2 丢弃旧缓存；
 *  2026-10-23 修军衔制双重计数 → key 升 v3；2026-10-29 口径收紧（偏好只算近 30 天登录、
 *  软件只算最近 1000 盘）→ key 升 v4；2026-11-02 软件分布改近 7 天 → key 升 v5；
 *  称号/地区分布卡已下线，军衔分布看 /admin/rank、地区看 /admin/stats） */
export const getDashboardDistributionsSoftwares = cache(async () => {
  const [softwares, titlePrefs] = await Promise.all([getSoftwareCounts(6), getTitlePrefCounts()]);
  return { softwares, titlePrefs };
}, "dashboard-softwares-v5");

/** 仪表盘异常检测（4 条全表聚合 ~2.5s，2026-10-21 挂缓存；数据变化频率低，10 分钟足够） */
export const getCachedAnomalies = cache(() => getAnomalies(), "anomalies");

/** 仪表盘两个大缓存统一 TTL（preheat 注册必须与底层 unstable_cache revalidate 同源，禁写字面量分叉） */
const DASHBOARD_TTL = 300;

/** 仪表盘概览 KPI（2026-11-04：约 25 条 COUNT/聚合 + 审核耗时全表扫，冷跑数秒 → 挂 5 分钟缓存。
 *  ov.now 即缓存填充时刻，「数据截至」展示仍准确；审核页 /admin/review 仍用实时 getOverview 不受影响） */
export const getCachedOverview = cache(() => getOverview(), "overview-v1", DASHBOARD_TTL);

/** 仪表盘 30 天趋势（2026-11-04：8 张表按天 GROUP BY → 挂 5 分钟缓存；
 *  缓存内含今日预估的同比快照，5 分钟窗口内偏差可忽略。数据分析页 /admin/stats 仍实时取数） */
export const getCachedTrend30 = cache(() => getTrend(30), "trend-30d-v1", DASHBOARD_TTL);

// TTL 前 60s 自驱动预热（2026-11-04 张老师要求：与前台首页同待遇，访客永不撞过期重建）。
// 本模块在管理后台首次渲染时被 import → 注册即接入 preheat 自驱动，此后进程内每
// TTL−60s（=4 分钟）自动重建一次；刚部署后首次访问仍是实时查询填缓存（一次性）。
registerPreheat("admin-overview", DASHBOARD_TTL, () => getCachedOverview());
registerPreheat("admin-trend30", DASHBOARD_TTL, () => getCachedTrend30());

/** 数据分析页：全表扫描类分布（串行，减少并发连接占用） */
export const getStatsDistributions = cache(async () => {
  const hourly = await getHourlyCounts();
  const weekday = await getWeekdayCounts();
  const areas = await getAreaCounts(12);
  const sex = await getSexCounts();
  const levels = await getLevelCounts();
  const nf = await getNfCounts();
  const boards = await getBoardCounts();
  const softwares = await getSoftwareCounts(8);
  return { hourly, weekday, areas, sex, levels, nf, boards, softwares };
}, "stats-distributions-v3"); // 2026-11-02 软件分布改「近 7 天」口径 → 升 v3 丢旧缓存

/** 纪录演变曲线（4 条，窗口函数排序开销大） */
export const getRecordCurves = cache(async () => {
  const expTime = await getRecordCurve("exp", "time");
  const expB3bvs = await getRecordCurve("exp", "3bvs");
  const intTime = await getRecordCurve("int", "time");
  const begTime = await getRecordCurve("beg", "time");
  return { expTime, expB3bvs, intTime, begTime };
}, "record-curves");

/** 各级别当前纪录 */
export const getCachedCurrentRecords = cache(() => getCurrentRecords(), "current-records");
