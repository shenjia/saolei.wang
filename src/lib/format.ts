// 格式化工具，移植自 2013 版 PHP 的 helpers/Format.php 与 helpers/Time.php
// 本模块保持「纯函数、零副作用」（不碰 prisma），服务端与客户端组件可共用；
// videoScores 2026-09-24 从 lib/queries 迁入，使录像行渲染件能被首页录像版块（客户端）复用。

import { MIN_3BV_FOR_3BVS } from "./config";

/** 录像成绩换算（移植 VideoModel::getScores）：time=real_time(ms)，3bvs=board_3bv×1e6/real_time，
 *  3BV 小于阈值时记负值（渲染层据此显示删除线，表示成绩不被承认） */
export function videoScores(board3bv: number, realTime: number): { time: number; "3bvs": number } {
  const sign = board3bv >= MIN_3BV_FOR_3BVS ? 1 : -1;
  return {
    time: realTime,
    "3bvs": realTime > 0 ? sign * Math.floor((board3bv * 1000000) / realTime) : 0,
  };
}

/** 时间成绩：存储为毫秒，显示为秒（2 位小数） */
export function scoreTime(score: number | null | undefined): string {
  if (!score || score <= 0) return "";
  return (score / 1000).toFixed(2);
}

/** 3BV/s 成绩：存储为实际值×1000，显示 3 位小数 */
export function score3bvs(score: number | null | undefined, negative = false): string {
  if (!score || (score <= 0 && !negative)) return "";
  return (score / 1000).toFixed(3);
}

const SECONDS_PER_DAY = 86400;
const NEVER = 3153600000; // 100 年，即「永远显示绝对时间」

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 绝对日期格式化（移植 PHP date() 的常用占位符） */
export function formatDate(time: number, format: string): string {
  const d = new Date(time * 1000);
  return format
    .replace("Y", String(d.getFullYear()))
    .replace("n", String(d.getMonth() + 1))
    .replace("m", pad(d.getMonth() + 1))
    .replace("j", String(d.getDate()))
    .replace("d", pad(d.getDate()))
    .replace("H", pad(d.getHours()))
    .replace("i", pad(d.getMinutes()));
}

/**
 * 相对时间（移植 Time::opposite）
 * @param time   Unix 秒
 * @param max    超过该秒数则显示绝对时间
 * @param format 绝对时间格式
 */
export function timeOpposite(
  time: number,
  max: number = SECONDS_PER_DAY,
  format = "Y年n月j日 H:i"
): string {
  let now = Math.floor(Date.now() / 1000);
  let t = time;

  if (Math.abs(t - now) > max) return formatDate(t, format);

  let direction = "前";
  if (t > now) {
    [now, t] = [t, now];
    direction = "后";
  }

  const minDis = Math.floor((now - t) / 60);
  const horDis = Math.floor((now - t) / 3600);
  const dayDis = Math.floor((now - t) / 86400);
  const wekDis = Math.floor(dayDis / 7);

  const nowDate = new Date(now * 1000);
  const tDate = new Date(t * 1000);
  let monDis =
    nowDate.getFullYear() * 12 + nowDate.getMonth() - (tDate.getFullYear() * 12 + tDate.getMonth());
  const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate();
  if (dayDis < daysInMonth) monDis = 0;

  let yerDis = nowDate.getFullYear() - tDate.getFullYear();
  let thisYearDays = 365;
  const y = nowDate.getFullYear();
  if ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) thisYearDays++;
  if (dayDis < thisYearDays) yerDis = 0;

  if (yerDis) return yerDis + "年" + direction;
  if (monDis) return monDis + "月" + direction;
  if (wekDis) return wekDis + "周" + direction;
  if (dayDis) return dayDis + "天" + direction;
  if (horDis) return horDis + "小时" + direction;
  if (minDis) return minDis + "分钟" + direction;
  return "刚刚";
}

export const TIME_NEVER = NEVER;
/** 一年（秒）：动态列表日期口径——一年内显示相对时间，超过一年显示日期（2026-09-23 张老师要求） */
export const TIME_YEAR = 365 * SECONDS_PER_DAY;

/** 距今是否不足一年（用于日期配色：一年内偏亮，一年以上偏暗，2026-09-24 张老师要求） */
export function isRecent(time: number): boolean {
  return Math.abs(Math.floor(Date.now() / 1000) - time) < TIME_YEAR;
}

/**
 * 「加载更多」按钮文案：括号内显示剩余未加载条数（2026-09-24 张老师要求，
 * 全站统一：动态/排行/进步榜/录像评论/论坛/军衔名单/扫雷历程）
 * @param remaining 剩余条数（已加载条数与总数之差，负值按 0 处理）
 */
export function moreLabel(remaining: number): string {
  return `加载更多（${Math.max(0, remaining).toLocaleString("zh-CN")}）`;
}
