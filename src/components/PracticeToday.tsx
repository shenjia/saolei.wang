// 首页「今日练习」板块（2026-10-22 张老师要求，五轮改版）：「开始练习」按钮下方。
// 首行「今日已完成 xxx / yyy 盘」：xxx=完成盘数（绿 #a6e22e）、yyy=尝试盘数（亮灰），
// 今日有尝试时最右侧胜率（一位小数，如 63.6%）——七轮（2026-10-22 张老师要求）：
// 标签「胜率」亮灰、数值绿色，与次行胜率「标签暗灰数值亮灰」同构分层。
// 次行「共xx位雷友完成 aaa / bbb 局」：aaa=全网完成（金 #fdc61a）、bbb=全网尝试（亮灰）。
// 底部走势图（2026-11-11 张老师要求改版）：只画「我的活跃值」单线（绿，近 7 天，
// 按自身最大值顶格归一，末点=今日实时活跃值，单调三次插值平滑）——原黄/绿双线
// （全网/我的练习次数）撤下。未登录不渲染图表（活跃值恒 ≥1 必然登录态才有，游客无
// 「自己」可画）。
// 「我的」今日局数双轨：登录=服务端 practice_log（SSR 直出）；未登录=localStorage
// 当日记数（practice-local.ts）——SSR 初值 0，水合后 useSyncExternalStore 接管补真值。

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getLocalPracticeToday, practiceLocalKey } from "@/lib/practice-local";
import { RankedTodayLine } from "@/components/RankedTodayLine";

const GREEN = "#a6e22e"; // 站内标准绿（.logo a h1 hover / Sparkline 默认色）

/** 单调三次插值（Fritsch–Carlson）：把稀疏数据点连成平滑贝塞尔曲线，且不过冲——
 *  不会画出高于峰值/低于 0 的假起伏（Catmull-Rom 类样条会过冲，对数据图是造假形态）。
 *  坐标系任意仿射变换下单调性保持，直接在 svg 视图坐标上算即可。 */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 2) return "";
  const dx: number[] = [];
  const s: number[] = []; // 各段割线斜率
  const m: number[] = new Array(n); // 各点切线斜率
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    s[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  m[0] = s[0];
  m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] * s[i] <= 0) m[i] = 0; // 局部极值点切线取 0，杜绝过冲
    else {
      // 加权调和平均（Fritsch–Carlson），保单调保 C1
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / s[i - 1] + w2 / s[i]);
    }
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i][0] + dx[i] / 3;
    const c1y = pts[i][1] + (m[i] * dx[i]) / 3;
    const c2x = pts[i + 1][0] - dx[i] / 3;
    const c2y = pts[i + 1][1] - (m[i + 1] * dx[i]) / 3;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${pts[i + 1][0].toFixed(2)},${pts[i + 1][1].toFixed(2)}`;
  }
  return d;
}

/** 我的活跃值单线图（2026-11-11）：按自身最大值顶格归一（0 点贴底、峰值距顶 3 单位），
 *  7 天窗口 + 单调三次插值平滑（点少也平滑且不过冲）。
 *  hover/触点出气泡（2026-11-11 张老师要求）：第一行日期、第二行「活跃值+xx」xx 绿色。
 *  命中用 pointer 比例法（clientX−rect.left)/rect.width——clientX 与 gBCR 同属视觉坐标，
 *  CSS zoom 缩放下比例恒定，全站 #page zoom 体系安全；气泡固定朝上方弹出（工程约定）。
 *  ⚠️ 触屏 tap 的指针序列以 pointerleave 结尾（触摸指针抬起即移除）——leave 只清鼠标态，
 *  触屏靠「tap 曲线外其他区域」的全局 pointerdown 收尾（下方 useEffect）。 */
function ActLine({ values, height }: { values: number[]; height: number }) {
  const [idx, setIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const n = values.length;
  if (n < 2) return null;
  const max = Math.max(...values, 1);
  const step = 100 / (n - 1);
  const px = (i: number) => i * step;
  const py = (v: number) => height - (v / max) * (height - 3) - 1.5;
  const pts = values.map((v, i) => [px(i), py(v)] as [number, number]);
  const d = smoothPath(pts);
  const pick = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const i = Math.round(((clientX - r.left) / r.width) * (n - 1));
    setIdx(Math.min(n - 1, Math.max(0, i)));
  };
  // 触屏收尾：气泡开着时，tap 本组件之外的任何区域即收起（capture 先于页面其他点击处理）
  useEffect(() => {
    if (idx === null) return;
    const onDoc = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setIdx(null);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [idx]);
  // 日期（末位=今天，往回推 n-1-i 天；hover 态只在客户端渲染，无 SSR 水合差异）
  const dt = new Date();
  dt.setDate(dt.getDate() - (n - 1 - (idx ?? 0)));
  // 事件绑在外层 div 上：SVG 元素的未绘制空白区不接收 pointer 事件（visiblePainted），
  // 绑 svg 上鼠标在细线之间滑动会频繁丢 hover
  return (
    <div
      ref={wrapRef}
      className="pt_chartwrap"
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setIdx(null);
      }}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") pick(e.clientX, e.currentTarget);
      }}
      onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
    >
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", width: "100%", height, touchAction: "pan-y", pointerEvents: "none" }}
        aria-hidden="true"
      >
        <path d={d} fill="none" stroke={GREEN} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.9" vectorEffect="non-scaling-stroke" />
        {idx !== null && (
          <g pointerEvents="none">
            <line x1={px(idx)} x2={px(idx)} y1={0} y2={height} stroke="#eeeeee" strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />
            <circle cx={px(idx)} cy={py(values[idx])} r="2.5" fill={GREEN} stroke="#272822" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {idx !== null && (
        <div className="pt_tip" style={{ left: `clamp(50px, ${(idx * step).toFixed(2)}%, calc(100% - 50px))` }}>
          <span className="pt_tip_date">{dt.getMonth() + 1}月{dt.getDate()}日</span>
          <span className="pt_tip_act">活跃值<b>+{values[idx]}</b></span>
        </div>
      )}
    </div>
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
  /** 近 7 天我的活跃值走势（2026-11-11 改版：不含今日的 6 天分日聚合，五源口径
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
  // 活跃值曲线（2026-11-11）：登录态=6 天历史 + 今日实时活跃值（getRankedToday 口径），共 7 点
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
