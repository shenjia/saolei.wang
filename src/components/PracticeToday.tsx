// 首页「今日练习」板块（2026-10-22 张老师要求，五轮改版）：「开始练习」按钮下方。
// 首行「今日已完成 xxx / yyy 盘」：xxx=完成盘数（绿 #a6e22e）、yyy=尝试盘数（亮灰），
// 今日有尝试时最右侧胜率（一位小数，如 63.6%）——七轮（2026-10-22 张老师要求）：
// 标签「胜率」亮灰、数值绿色，与次行胜率「标签暗灰数值亮灰」同构分层。
// 次行「共xx位雷友完成 aaa / bbb 局」：aaa=全网完成（金 #fdc61a）、bbb=全网尝试（亮灰）。
// 底部近 30 天双线折线铺满模块宽：黄线=全网尝试盘数（按自身最大值顶格归一）、
// 绿线=我的尝试盘数（峰值只归一到 0.618 高度，2026-10-22 张老师要求——
// 避免两线各自顶格归一后几乎重合、看不出量级差）。
// 「我的」双轨：登录=服务端 practice_log（SSR 直出）；未登录=localStorage 当日记数
// （practice-local.ts）——SSR 初值 0，水合后 useSyncExternalStore 接管补真值。

"use client";

import { useRef, useSyncExternalStore } from "react";
import {
  getLocalPracticeTrend,
  getLocalPracticeToday,
  practiceLocalKey,
} from "@/lib/practice-local";

const GREEN = "#a6e22e"; // 站内标准绿（.logo a h1 hover / Sparkline 默认色）
const YELLOW = "#e6db74"; // 站内标准黄（后台趋势「新玩家」序列同色）

/** 双线叠加图：黄=全网按自身最大值顶格归一；绿=我同样归一但峰值封顶 0.618 倍绘图高——
 *  量级悬殊时两条线靠高度差拉开，不再因「各画各的顶格」而重合 */
function DoubleLine({ mine, net, height }: { mine: number[]; net: number[]; height: number }) {
  if (mine.length < 2 || net.length < 2) return null;
  const path = (values: number[], top: number): string => {
    const max = Math.max(...values, 1);
    const step = 100 / (values.length - 1);
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(height - (v / max) * (height - 3) * top - 1.5).toFixed(2)}`)
      .join(" ");
  };
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }} aria-hidden="true">
      {/* 黄（全网）画在下层：参与人数/大盘量级通常高于个人 */}
      <path d={path(net, 1)} fill="none" stroke={YELLOW} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.75" vectorEffect="non-scaling-stroke" />
      <path d={path(mine, 0.618)} fill="none" stroke={GREEN} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.9" vectorEffect="non-scaling-stroke" />
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
  trendNet,
  trendMine,
  logged,
}: {
  /** DOM id 前缀：桌面侧栏 "practice_today" / 移动端 "practice_today_top" */
  prefix: string;
  /** 排行模式今日统计行（2026-10-28 张老师定）：今日玩过排行模式才由服务端下发，
   *  null=不渲染。ranked=今日是否玩过排行模式（practice_daily.mode_ranked>0；
   *  false 时整行隐藏，2026-10-29 口径）、b/i/e=初/中/高级今日新收集 BV 数、
   *  z=今日 PB 次数（0 值降亮灰同 b/i/e） */
  rankedToday: { ranked: boolean; beg: number; int: number; exp: number; pb: number } | null;
  /** 服务端口径「我的完成盘数」：登录=practice_log 当日 won=1 计数；未登录恒 0 */
  mineWon: number;
  /** 服务端口径「我的尝试盘数」：未登录恒 0 */
  mine: number;
  /** 全网完成盘数（won=1） */
  netWon: number;
  /** 全网尝试盘数 */
  net: number;
  users: number;
  /** 近 30 天全网尝试走势（末位=今日） */
  trendNet: number[];
  /** 近 30 天我的尝试走势（登录=practice_log 分日；未登录由 localStorage 趋势替代） */
  trendMine: number[];
  /** 登录态：true=信任服务端；false=读 localStorage */
  logged: boolean;
}) {
  // 未登录：水合后从 localStorage 取「今日完成/尝试」+ 近 30 天尝试趋势。
  // getSnapshot 必须返回缓存引用（每次新建对象会触发无限重渲）——ref 内按内容判等换新。
  const snapRef = useRef<{ today: { p: number; w: number }; trend: number[] } | null>(null);
  const snapEqual = (a: { p: number; w: number } | null, b: { p: number; w: number } | null) =>
    a === b || (!!a && !!b && a.p === b.p && a.w === b.w);
  const local = useSyncExternalStore(
    subscribePractice,
    () => {
      if (logged) return null;
      const today = getLocalPracticeToday();
      const prev = snapRef.current;
      if (prev && snapEqual(prev.today, today)) return prev; // 今日值没变：沿用旧引用（trend 同源同判）
      const snap = { today, trend: getLocalPracticeTrend(trendNet.length) };
      snapRef.current = snap;
      return snap;
    },
    () => null
  );
  const myWon = local?.today.w ?? mineWon;
  const myPlayed = local?.today.p ?? mine;
  // 未登录趋势与全网趋势按尾对齐（localStorage 天数不足时前面补 0，多了截断）
  const myTrend = (() => {
    if (logged) return trendMine;
    if (!local) return trendNet.map(() => 0);
    const lt = local.trend;
    if (lt.length >= trendNet.length) return lt.slice(lt.length - trendNet.length);
    return [...Array(trendNet.length - lt.length).fill(0), ...lt];
  })();
  const r = rate(myWon, myPlayed);
  const rNet = rate(netWon, net);
  return (
    <div id={prefix} className="practice_today">
      {/* 排行模式今日统计行（2026-10-28 张老师定）：仅今日玩过排行模式
          （practice_daily.mode_ranked>0，ranked 标志）才渲染——今天没玩排行
          模式时整行隐藏（2026-10-29 00:58 张老师重申口径；练习页 op_ranked
          才是「登录恒显亮灰 0」口径，两处不同）。「今日已收集 b / i / e BV
          创造 z PB」——b/i/e 按级别三色（初绿 #a6e22e / 中橙 #f79646 /
          高金 #fdc61a，与纪录页级别色同源），0 值降亮灰不抢眼；z=今日 PB
          次数，0 值同降亮灰 */}
      {rankedToday?.ranked && (
        <p className="pt_line pt_ranked">
          <span className="lead">今日已收集</span>
          <b className={`lv lv_beg${rankedToday.beg > 0 ? "" : " zero"}`}>{rankedToday.beg}</b>
          <span className="sep">/</span>
          <b className={`lv lv_int${rankedToday.int > 0 ? "" : " zero"}`}>{rankedToday.int}</b>
          <span className="sep">/</span>
          <b className={`lv lv_exp${rankedToday.exp > 0 ? "" : " zero"}`}>{rankedToday.exp}</b>
          <span className="lead">BV</span>
          <span className="pbpart">
            创造 <b className={`pbv${rankedToday.pb > 0 ? "" : " zero"}`}>{rankedToday.pb}</b> PB
          </span>
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
      <div className="pt_chart">
        <DoubleLine mine={myTrend} net={trendNet} height={38} />
      </div>
    </div>
  );
}
