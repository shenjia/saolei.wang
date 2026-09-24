// 后台图表组件（2026-09-24）
// 零依赖纯 SVG / CSS 实现，与 01xue.com 后台同思路：不引第三方图表库，
// 避免为几张图表引入 recharts/echarts 这类几百 KB 的运行时。
//
// 色板固定取主站 2013 Monokai，调用方只传 key，颜色由 SERIES_COLORS 统一给。

"use client";

import { useEffect, useRef, useState } from "react";

export const SERIES_COLORS = [
  "#a6e22e", "#66d9ef", "#e6db74", "#f79646",
  "#ae81ff", "#f92672", "#b1b1a4", "#7dd3fc",
];

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

// ---------- 折线 / 面积图（多序列 + 图例开关 + 悬浮明细） ----------

export function TrendChart({
  dates,
  series: allSeries,
  height = 240,
  unit = "",
  defaultHidden = [],
}: {
  dates: string[];
  series: Series[];
  height?: number;
  /** 数值单位后缀（如「秒」「人」），仅用于浮层与轴 */
  unit?: string;
  /** 初始即隐藏的序列 key（量级悬殊时避免小值序列被压平） */
  defaultHidden?: string[];
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(defaultHidden.map((k) => [k, true]))
  );
  const series = allSeries.filter((s) => !hidden[s.key]);
  const [hover, setHover] = useState<number | null>(null);
  const [cursorPx, setCursorPx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(1000);

  const W = 1000;
  const H = height;
  const padX = 10;
  const padTop = 16;
  const padBottom = 24;
  const n = dates.length;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBoxW(el.clientWidth || W);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const step = n > 1 ? (W - padX * 2) / (n - 1) : 0;
  const x = (i: number) => padX + i * step;
  const y = (v: number) => padTop + (1 - v / max) * (H - padTop - padBottom);
  const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });

  const labelStep = Math.max(1, Math.ceil(n / 10));
  const hovered = hover !== null ? hover : null;

  const pick = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || n < 2) return;
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round((svgX - padX) / step);
    setHover(Math.min(n - 1, Math.max(0, i)));
    setCursorPx(clientX - rect.left);
  };

  if (n < 2) return <div className="admin_empty">暂无数据</div>;

  // 浮层定位：以光标相对竖线为界翻向
  const TIP_W = 168;
  const scale = boxW / W;
  const boxH = H * scale;
  const tipRows = series.length;
  const TIP_H = 30 + tipRows * 19;
  const tipLeft = (() => {
    if (hover === null) return 0;
    const px = x(hover) * scale;
    const toLeft = cursorPx === null ? px < boxW / 2 : cursorPx < px;
    const left = toLeft ? px + 12 : px - 12 - TIP_W;
    return Math.min(Math.max(left, 4), Math.max(4, boxW - TIP_W - 4));
  })();
  const tipTop = (() => {
    if (hover === null) return 6;
    if (boxH < TIP_H + 12) return 0;
    const py = y(max) * scale;
    void py;
    const lowest = Math.max(...series.map((s) => y(s.values[hover] ?? 0) * scale));
    return lowest < boxH / 2 ? Math.max(4, boxH - padBottom * scale - TIP_H - 4) : 6;
  })();

  return (
    <div>
      {allSeries.length > 1 && (
        <div className="admin_legend">
          {allSeries.map((s) => {
            const off = hidden[s.key];
            const total = s.values.reduce((a, b) => a + b, 0);
            return (
              <button
                key={s.key}
                type="button"
                className={off ? "off" : "on"}
                onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}
              >
                <i style={{ background: s.color }} />
                {s.label}
                <b>{total.toLocaleString("zh-CN")}</b>
              </button>
            );
          })}
        </div>
      )}

      <div className="admin_chart" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="趋势图"
          style={{ touchAction: "pan-y" }}
          onPointerLeave={() => {
            setHover(null);
            setCursorPx(null);
          }}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerDown={(e) => pick(e.clientX)}
        >
          {/* 横网格 + 纵轴刻度 */}
          {[0, 0.25, 0.5, 0.75, 1].map((r) => {
            const gy = padTop + r * (H - padTop - padBottom);
            return (
              <g key={r}>
                <line
                  x1={padX}
                  x2={W - padX}
                  y1={gy}
                  y2={gy}
                  stroke="#49483e"
                  strokeOpacity={r === 1 ? 0.9 : 0.5}
                  strokeDasharray={r === 1 ? "0" : "3 4"}
                />
                <text x={W - padX} y={gy - 3} fontSize="9" fill="#75715e" textAnchor="end">
                  {Math.round(max * (1 - r)).toLocaleString("zh-CN")}
                  {unit}
                </text>
              </g>
            );
          })}

          {series.map((s) => {
            const line = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
            return (
              <g key={s.key}>
                {series.length === 1 && (
                  <path
                    d={`${line} L${x(n - 1)},${H - padBottom} L${x(0)},${H - padBottom} Z`}
                    fill={s.color}
                    fillOpacity="0.13"
                  />
                )}
                <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
              </g>
            );
          })}

          {hovered !== null && (
            <g pointerEvents="none">
              <line
                x1={x(hovered)}
                x2={x(hovered)}
                y1={padTop - 6}
                y2={H - padBottom}
                stroke="#eeeeee"
                strokeOpacity="0.35"
              />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(hovered)}
                  cy={y(s.values[hovered] ?? 0)}
                  r="3.5"
                  fill={s.color}
                  stroke="#272822"
                  strokeWidth="1.5"
                />
              ))}
            </g>
          )}

          {dates.map((d, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={d + i}
                x={x(i)}
                y={H - 7}
                fontSize="10"
                fill="#75715e"
                fillOpacity={hover === i ? 0.95 : 0.7}
                textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
              >
                {d.slice(5)}
              </text>
            ) : null
          )}
        </svg>

        {hovered !== null && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: tipLeft,
              top: tipTop,
              width: TIP_W,
              background: "rgba(30,31,28,0.96)",
              border: "1px solid #49483e",
              borderRadius: 8,
              padding: "7px 10px",
              boxShadow: "0 6px 18px rgba(0,0,0,.45)",
            }}
          >
            <div style={{ color: "#75715e", fontSize: 11, lineHeight: "16px" }}>{dates[hovered]}</div>
            {series.map((s) => (
              <div key={s.key} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: "19px", marginTop: 2 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#939387", flex: 1 }}>
                  <i style={{ width: 8, height: 8, borderRadius: 4, background: s.color, display: "inline-block" }} />
                  {s.label}
                </span>
                <b style={{ color: s.color, fontVariantNumeric: "tabular-nums" }}>
                  {fmt(s.values[hovered] ?? 0)}
                  {unit}
                </b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 水平条形榜 ----------

export function BarList({
  items,
  emptyText = "暂无数据",
  color,
}: {
  items: { label: string; value: number; hint?: string; href?: string; color?: string }[];
  emptyText?: string;
  /** 统一条色（item.color 优先）；刻意用字符串而非回调——客户端组件不能接服务端传的函数 */
  color?: string;
}) {
  if (!items.length) return <div className="admin_empty">{emptyText}</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="admin_bars">
      {items.map((it) => (
        <div className="admin_bar" key={it.label}>
          <span className="name" title={it.label}>
            {it.label}
          </span>
          <span className="track">
            <span
              className="fill"
              style={{
                width: `${Math.max(2, (it.value / max) * 100)}%`,
                background: it.color ?? color ?? "linear-gradient(90deg,#6f9a1f,#a6e22e)",
              }}
            />
          </span>
          <span className="val">{it.value.toLocaleString("zh-CN")}</span>
          {it.hint !== undefined && <span className="hint">{it.hint}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------- 纵向柱状（时段 / 星期） ----------

export function ColumnChart({
  items,
  color = "linear-gradient(180deg,#a6e22e,#6f9a1f)",
  height = 122,
}: {
  items: { label: string; value: number }[];
  color?: string;
  height?: number;
}) {
  if (!items.length) return <div className="admin_empty">暂无数据</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="admin_columns" style={{ height }}>
      {items.map((it) => (
        <div className="col" key={it.label} title={`${it.label}：${it.value.toLocaleString("zh-CN")}`}>
          <div className="bar" style={{ height: `${Math.max(1.5, (it.value / max) * 100)}%`, background: color }} />
          <span className="x">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- 环形占比 ----------

export function Donut({
  items,
  centerLabel,
}: {
  items: { label: string; value: number }[];
  centerLabel?: string;
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return <div className="admin_empty">暂无数据</div>;
  const R = 52;
  const C = 2 * Math.PI * R;
  // 渲染前先把每段的角度累计好（用 reduce 累积，避免改渲染期外部变量，react-hooks/immutability）
  const segs = items.reduce<
    { list: { key: string; color: string; dasharray: string; dashoffset: number }[]; acc: number }
  >(
    (state, it, idx) => {
      const frac = it.value / total;
      return {
        list: [
          ...state.list,
          {
            key: it.label,
            color: SERIES_COLORS[idx % SERIES_COLORS.length],
            dasharray: `${frac * C} ${C}`,
            dashoffset: -state.acc * C,
          },
        ],
        acc: state.acc + frac,
      };
    },
    { list: [], acc: 0 }
  ).list;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg viewBox="0 0 140 140" style={{ width: 132, height: 132, flex: "0 0 132px" }} role="img" aria-label="占比">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#3a3a32" strokeWidth="15" />
        {segs.map((s) => (
          <circle
            key={s.key}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth="15"
            strokeDasharray={s.dasharray}
            strokeDashoffset={s.dashoffset}
            transform="rotate(-90 70 70)"
          />
        ))}
        <text x="70" y="66" fontSize="19" fontWeight="bold" fill="#eeeeee" textAnchor="middle">
          {total.toLocaleString("zh-CN")}
        </text>
        <text x="70" y="83" fontSize="10" fill="#75715e" textAnchor="middle">
          {centerLabel ?? "合计"}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 13, minWidth: 130 }}>
        {items.map((it, idx) => (
          <div key={it.label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: SERIES_COLORS[idx % SERIES_COLORS.length],
                flex: "0 0 9px",
              }}
            />
            <span style={{ color: "#939387", flex: 1 }}>{it.label}</span>
            <span style={{ color: "#b1b1a4", fontVariantNumeric: "tabular-nums" }}>{it.value.toLocaleString("zh-CN")}</span>
            <span style={{ color: "#75715e", fontSize: 12, width: 46, textAlign: "right" }}>
              {((it.value / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 迷你走势线（KPI 卡内嵌） ----------

export function Sparkline({ values, color = "#a6e22e", width = 96, height = 26 }: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${i * step},${height - (v / max) * (height - 3) - 1.5}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.85" />
    </svg>
  );
}
