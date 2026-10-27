"use client";

// 纪录页左侧「纪录演变」图表组（2026-10-28，张老师需求：导航「纪录」→ /records）
// · 图表口径与后台「纪录演变」一致：只取「每一次刷新纪录」的点（数据端 lib/records.ts）。
// · 每点 hover 浮层：日期（距今天数）/ 纪录值 / 创造者（名字 + 双体系称号徽章）/ 保持时长；
//   卡片小标题的纪录值点击跳对应录像；创造者名字跳个人主页。
// · 零依赖纯 SVG（同后台 Charts.tsx 思路）：点少全宽铺开，点多横向滚动（每点 26px 占位）。
// · 「距今 N 天」按浏览器本地时间实时算——SSR 与客户端可能跨天差 1，
//   该 span 挂 suppressHydrationWarning（绝对日期不受影响）。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TitleBadge } from "./TitleBadge";
import type { TitlePair } from "@/lib/title-system";

export interface CurvePoint {
  /** 录像 id（点击跳 /video/<v>） */
  v: number;
  /** 创造者 uid（跳 /user/<u>） */
  u: number;
  n: string;
  /** 上传时刻 Unix 秒（纪录创造时间） */
  x: number;
  /** 纪录值原值：time=毫秒；3bvs=×1000；stnb=原值 */
  y: number;
  /** 双体系称号对（服务端批量换算好） */
  t: TitlePair;
}

export interface CurveChart {
  metric: "time" | "3bvs" | "stnb";
  metricName: string;
  points: CurvePoint[];
}

export interface CurveGroup {
  level: "beg" | "int" | "exp";
  levelName: string;
  charts: CurveChart[];
}

const H = 150;
const PAD_T = 14;
const PAD_B = 22;
const PAD_X = 8;
/** 点多时每个点的横向占位（px），超出容器宽即出现横向滚动 */
const PER_POINT = 26;

/** 纪录值显示：与全站口径一致（time 2 位小数秒 / 3bvs 3 位小数 / stnb 2 位小数） */
function fmtVal(metric: CurveChart["metric"], v: number): string {
  if (metric === "time") return (v / 1000).toFixed(2);
  if (metric === "3bvs") return (v / 1000).toFixed(3);
  return v.toFixed(2);
}

/** 轴/浮层通用格式（Y 轴刻度 2 位足够读） */
function fmtAxis(metric: CurveChart["metric"], v: number): string {
  if (metric === "3bvs") return (v / 1000).toFixed(2);
  if (metric === "stnb") return v.toFixed(2);
  return (v / 1000).toFixed(2);
}

/** +08:00 日期（与全站切天口径一致） */
function fmtDate(ts: number): string {
  return new Date((ts + 28800) * 1000).toISOString().slice(0, 10);
}

function daysAgo(ts: number): number {
  return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 86400));
}

/** 保持时长：下一点 - 本点；末点=至今 */
function holdText(fromTs: number, toTs: number): string {
  const d = Math.round((toTs - fromTs) / 86400);
  if (d >= 365) return `${(d / 365).toFixed(1).replace(/\.0$/, "")} 年`;
  if (d >= 30) return `${(d / 30).toFixed(1).replace(/\.0$/, "")} 个月`;
  return `${d} 天`;
}

function ChartCard({ chart }: { chart: CurveChart }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [tipLeft, setTipLeft] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBoxW(el.clientWidth || 600);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = chart.points;
  const n = pts.length;

  if (n < 2) {
    return (
      <div className="rec_card">
        <div className="rec_head">
          <span className="rec_name">{chart.metricName}：</span>
          <span className="rec_meta">暂无数据</span>
        </div>
        <div className="rec_chart_empty">暂无数据</div>
      </div>
    );
  }

  const W = Math.max(boxW, n * PER_POINT);
  const vals = pts.map((p) => p.y);
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const span = mx - mn || 1;
  const y = (v: number) => PAD_T + (1 - (v - mn) / span) * (H - PAD_T - PAD_B);
  const x = (i: number) => PAD_X + (W - PAD_X * 2) * (i / (n - 1));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.y)}`).join(" ");

  const labelStep = Math.max(1, Math.ceil(n / 8));
  const last = pts[n - 1];

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - sx);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    // 浮层在滚动容器内定位：可视 x = 图形 x - scrollLeft；近右缘翻向左侧
    const vw = el.clientWidth;
    const visX = x(best) - el.scrollLeft;
    let tl = visX + 12;
    if (tl + 222 > vw) tl = visX - 222 - 12;
    setTipLeft(Math.min(Math.max(4, tl), Math.max(4, vw - 226)));
    setHover(best);
  };

  const hp = hover !== null ? pts[hover] : null;

  return (
    <div className="rec_card">
      <div className="rec_head">
        <span className="rec_name">{chart.metricName}：</span>
        <Link className="rec_val" href={`/video/${last.v}`} title="点击查看该录像">
          {fmtVal(chart.metric, last.y)}
        </Link>
        <span className="rec_meta">
          ：<Link className="rec_user" href={`/user/${last.u}`}>{last.n}</Link>{" "}
          <TitleBadge title={last.t.m} classic={last.t.c} />　{fmtDate(last.x)}（距今{" "}
          <span suppressHydrationWarning>{daysAgo(last.x)}</span> 天）
        </span>
      </div>
      <div
        className="rec_chart"
        ref={wrapRef}
        onScroll={() => setHover(null)}
      >
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${chart.metricName}演变`}
          style={{ touchAction: "pan-y" }}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((r) => {
            const gy = PAD_T + r * (H - PAD_T - PAD_B);
            const gv = mx - (mx - mn) * r;
            return (
              <g key={r}>
                <line
                  x1={PAD_X}
                  x2={W - PAD_X}
                  y1={gy}
                  y2={gy}
                  stroke="#49483e"
                  strokeOpacity={r === 1 ? 0.9 : 0.5}
                  strokeDasharray={r === 1 ? "0" : "3 4"}
                />
                <text x={W - PAD_X} y={gy - 3} fontSize="9" fill="#75715e" textAnchor="end">
                  {fmtAxis(chart.metric, gv)}
                </text>
              </g>
            );
          })}
          <path
            d={`${line} L${x(n - 1)},${H - PAD_B} L${x(0)},${H - PAD_B} Z`}
            fill="#a6e22e"
            fillOpacity="0.13"
          />
          <path d={line} fill="none" stroke="#a6e22e" strokeWidth="2" strokeLinejoin="round" />
          {hp && (
            <g pointerEvents="none">
              <line
                x1={x(hover!)}
                x2={x(hover!)}
                y1={PAD_T - 6}
                y2={H - PAD_B}
                stroke="#eeeeee"
                strokeOpacity="0.35"
              />
              <circle
                cx={x(hover!)}
                cy={y(hp.y)}
                r="3.5"
                fill="#a6e22e"
                stroke="#272822"
                strokeWidth="1.5"
              />
            </g>
          )}
          {pts.map((p, i) =>
            (i % labelStep === 0 && i !== n - 2) || i === n - 1 ? (
              <text
                key={i}
                x={x(i)}
                y={H - 7}
                fontSize="10"
                fill="#75715e"
                textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
              >
                {fmtDate(p.x).slice(2)}
              </text>
            ) : null
          )}
        </svg>
        {hp && (
          <div className="rec_tip" style={{ left: tipLeft }}>
            <div className="d">
              {fmtDate(hp.x)}（距今 <span suppressHydrationWarning>{daysAgo(hp.x)}</span> 天）
            </div>
            <div className="row">
              <span>纪录值</span>
              <b>{fmtVal(chart.metric, hp.y)}</b>
            </div>
            <div className="row">
              <span>创造者</span>
              <span className="who">
                <Link href={`/user/${hp.u}`}>{hp.n}</Link>{" "}
                <TitleBadge title={hp.t.m} classic={hp.t.c} />
              </span>
            </div>
            <div className="row">
              <span>保持时长</span>
              <b className="hold">
                {hover === n - 1
                  ? "至今"
                  : holdText(hp.x, pts[hover! + 1].x)}
              </b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function RecordsCurves({ groups }: { groups: CurveGroup[] }) {
  return (
    <>
      {groups.map((g) => (
        <section className="rec_group" key={g.level}>
          <h2>{g.levelName}纪录</h2>
          {g.charts.map((c) => (
            <ChartCard key={c.metric} chart={c} />
          ))}
        </section>
      ))}
    </>
  );
}
