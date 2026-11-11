// 首页「今日练习」板块（2026-10-22 张老师要求，五轮改版）：「开始练习」按钮下方。
// 首行「今日已完成 xxx / yyy 盘」：xxx=完成盘数（绿 #a6e22e）、yyy=尝试盘数（亮灰），
// 今日有尝试时最右侧胜率（一位小数，如 63.6%）——七轮（2026-10-22 张老师要求）：
// 标签「胜率」亮灰、数值绿色，与次行胜率「标签暗灰数值亮灰」同构分层。
// 次行「共xx位雷友完成 aaa / bbb 局」：aaa=全网完成（金 #fdc61a）、bbb=全网尝试（亮灰）。
// 底部走势图（2026-11-11 张老师要求改版）：只画「我的活跃值」单线（绿，近 30 天，
// 按自身最大值顶格归一，末点=今日实时活跃值）——原黄/绿双线（全网/我的练习次数）
// 撤下。未登录不渲染图表（活跃值恒 ≥1 必然登录态才有，游客无「自己」可画）。
// 「我的」今日局数双轨：登录=服务端 practice_log（SSR 直出）；未登录=localStorage
// 当日记数（practice-local.ts）——SSR 初值 0，水合后 useSyncExternalStore 接管补真值。

"use client";

import { useRef, useSyncExternalStore } from "react";
import { getLocalPracticeToday, practiceLocalKey } from "@/lib/practice-local";
import { RankedTodayLine } from "@/components/RankedTodayLine";

const GREEN = "#a6e22e"; // 站内标准绿（.logo a h1 hover / Sparkline 默认色）

/** 我的活跃值单线图（2026-11-11）：按自身最大值顶格归一（0 点贴底、峰值距顶 3 单位） */
function ActLine({ values, height }: { values: number[]; height: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(height - (v / max) * (height - 3) - 1.5).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }} aria-hidden="true">
      <path d={d} fill="none" stroke={GREEN} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.9" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 订阅 localStorage「今日练习」记数的变更（同窗口立即通知 + 跨 tab storage 事件） */
const subscribePractice = (cb: () => void): (() => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(practiceLocalKey, cb); // OnlinePlay bumpLocalPractice 后派发
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(practiceLocalKey, cb);
  };
};

/** 胜率（0-100，一位小数）；无尝试返回 null（不渲染） */
const rate = (won: number, played: number): number | null =>
  played > 0 ? Math.round((won / played) * 1000) / 10 : null;

export function PracticeToday({
  prefix,
  rankedToday,
  mineWon,
  mine,
  netWon,
  net,
  users,
  actTrend,
  logged,
}: {
  /** DOM id 前缀：桌面侧栏 "practice_today" / 移动端 "practice_today_top" */
  prefix: string;
  /** 首行统计（2026-11-08 张老师改版）：登录恒下发（未登录 null 不渲染）。
   *  ranked=今日是否玩过排行模式（不再控制显隐）；b/i/e=初/中/高级今日新收集
   *  BV 数（合计单值展示）、pb=今日 PB 次数（0 值降亮灰）、act=今日活跃值
   *  （2026-11-11 张老师定：活跃榜 active_points 同口径的当日值，登录 1 点打底恒 ≥1，
   *  >0 绿色） */
  rankedToday: { ranked: boolean; beg: number; int: number; exp: number; pb: number; act: number } | null;
  /** 服务端口径「我的完成盘数」：登录=practice_log 当日 won=1 计数；未登录恒 0 */
  mineWon: number;
  /** 服务端口径「我的尝试盘数」：未登录恒 0 */
  mine: number;
  /** 全网完成盘数（won=1） */
  netWon: number;
  /** 全网尝试盘数 */
  net: number;
  users: number;
  /** 近 30 天我的活跃值走势（2026-11-11 改版：不含今日的 29 天分日聚合，五源口径
   *  与活跃榜 active_points 一致；登录才有、未登录恒 []）。末点由本组件拼今日实时值 */
  actTrend: number[];
  /** 登录态：true=信任服务端；false=读 localStorage（今日局数） */
  logged: boolean;
}) {
  // 未登录：水合后从 localStorage 取「今日完成/尝试」（走势图已撤，不再读本地趋势）。
  // getSnapshot 必须返回缓存引用（每次新建对象会触发无限重渲）——ref 内按内容判等换新。
  const snapRef = useRef<{ p: number; w: number } | null>(null);
  const local = useSyncExternalStore(
    subscribePractice,
    () => {
      if (logged) return null;
      const today = getLocalPracticeToday();
      const prev = snapRef.current;
      if (prev && prev.p === today.p && prev.w === today.w) return prev;
      snapRef.current = today;
      return today;
    },
    () => null
  );
  const myWon = local?.w ?? mineWon;
  const myPlayed = local?.p ?? mine;
  // 活跃值曲线（2026-11-11）：登录态=29 天历史 + 今日实时活跃值（getRankedToday 口径）
  const trend = logged && rankedToday && actTrend.length > 0 ? [...actTrend, rankedToday.act] : null;
  const r = rate(myWon, myPlayed);
  const rNet = rate(netWon, net);
  return (
    <div id={prefix} className="practice_today">
      {/* 首行统计（2026-11-08 张老师改版）：登录恒显（原口径仅今日玩过排行模式才渲染，
          活跃值入行后无收获也亮灰展示——「活跃>0 绿色」意味着 0 也占位）。
          版式（BV 合计单值 / 连接 PB / 活跃+z 右锚定）与练习页 op_ranked 共用
          RankedTodayLine 组件；本页字号 18px、标签暗灰 #75715e（胜率同款） */}
      {rankedToday && (
        <p className="pt_line pt_ranked">
          <RankedTodayLine
            beg={rankedToday.beg}
            int={rankedToday.int}
            exp={rankedToday.exp}
            pb={rankedToday.pb}
            act={rankedToday.act}
          />
        </p>
      )}
      <p className="pt_line">
        <span className="lead">今日已完成</span>
        <b className="mine">{myWon}</b>
        <span className="sep">/</span>
        <b className="total">{myPlayed}</b>
        <span className="lead">局</span>
        {r !== null && (
          <span className="rate">
            胜率 <b className="ratev">{r}%</b>
          </span>
        )}
      </p>
      <p className="pt_sub">
        共<b className="users">{users}</b>位雷友完成<b className="net">{netWon}</b>
        <span className="sep"> / </span>
        <b className="netb">{net}</b>局{rNet !== null && <span className="rate">胜率 <b className="ratev">{rNet}%</b></span>}
      </p>
      {/* 我的活跃值单线（2026-11-11 改版；未登录不渲染） */}
      {trend && (
        <div className="pt_chart">
          <ActLine values={trend} height={38} />
        </div>
      )}
    </div>
  );
}
