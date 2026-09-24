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
import { getTitleCounts } from "@/lib/queries";
import {
  getAreaCounts,
  getBoardCounts,
  getCurrentRecords,
  getHourlyCounts,
  getLevelCounts,
  getNfCounts,
  getRecordCurve,
  getSexCounts,
  getSoftwareCounts,
  getWeekdayCounts,
} from "./stats";

export const ADMIN_CACHE_TTL = 600; // 10 分钟

const cache = <T>(fn: () => Promise<T>, key: string) =>
  unstable_cache(fn, [`admin-v1-${key}`], { revalidate: ADMIN_CACHE_TTL, tags: ["admin-stats"] });

/** 仪表盘分布（军衔 / 地区 / 软件）——内部串行执行，避免一次性占满连接 */
export const getDashboardDistributions = cache(async () => {
  const titles = await getTitleCounts();
  const areas = await getAreaCounts(10);
  const softwares = await getSoftwareCounts(6);
  return { titles, areas, softwares };
}, "dashboard-distributions");

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
}, "stats-distributions");

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
