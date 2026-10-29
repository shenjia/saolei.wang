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
import {
  getAnomalies,
  getAreaCounts,
  getBoardCounts,
  getCurrentRecords,
  getHourlyCounts,
  getLevelCounts,
  getNfCounts,
  getRecordCurve,
  getSexCounts,
  getSoftwareCounts,
  getTitlePrefCounts,
  getWeekdayCounts,
} from "./stats";

export const ADMIN_CACHE_TTL = 600; // 10 分钟

const cache = <T>(fn: () => Promise<T>, key: string) =>
  unstable_cache(fn, [`admin-v1-${key}`], { revalidate: ADMIN_CACHE_TTL, tags: ["admin-stats"] });

/** 仪表盘软件分布 + 称号体系偏好（2026-10-21 加 titlePrefs，载荷结构变更 → key 升 v2 丢弃旧缓存；
 *  2026-10-23 修军衔制双重计数 → key 升 v3；2026-10-29 口径收紧（偏好只算近 30 天登录、
 *  软件只算最近 1000 盘）→ key 升 v4；称号/地区分布卡已下线，军衔分布看 /admin/rank、地区看 /admin/stats） */
export const getDashboardDistributionsSoftwares = cache(async () => {
  const [softwares, titlePrefs] = await Promise.all([getSoftwareCounts(6), getTitlePrefCounts()]);
  return { softwares, titlePrefs };
}, "dashboard-softwares-v4");

/** 仪表盘异常检测（4 条全表聚合 ~2.5s，2026-10-21 挂缓存；数据变化频率低，10 分钟足够） */
export const getCachedAnomalies = cache(() => getAnomalies(), "anomalies");

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
}, "stats-distributions-v2"); // 2026-10-29 软件分布改「最近 1000 盘」口径 → 升 v2 丢旧缓存

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
