// 后台图表组件（2026-09-24；2026-10-21 占比图改版）
// 零依赖纯 SVG / CSS 实现，与 01xue.com 后台同思路：不引第三方图表库，
// 避免为几张图表引入 recharts/echarts 这类几百 KB 的运行时。
//
// 色板固定取主站 2013 Monokai，调用方只传 key，颜色由 SERIES_COLORS 统一给。
// 2026-10-21 占比图改版（对齐 01xue.com 后台）：实心 Pie 淘汰，统一环形 Donut
// （中心汇总 + 图例悬浮联动高亮 + 2 位小数百分比 + <0.5% 小项合并「其他」）。

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
  const [cursorPy, setCursorPy] = useState<number | null>(null);
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

  const pick = (clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || n < 2) return;
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round((svgX - padX) / step);
    setHover(Math.min(n - 1, Math.max(0, i)));
    setCursorPx(clientX - rect.left);
    setCursorPy(clientY - rect.top);
  };

  if (n < 2) return <div className="admin_empty">暂无数据</div>;

  // 浮层定位：跟随鼠标（水平以光标为锚点翻向，垂直以光标为中线上下翻）
  const TIP_W = 168;
  // 浮层实际占位 = content + 左右 padding 20 + border 2（clamp 右界按总宽算）
  const TIP_OUTER_W = TIP_W + 22;
  const scale = boxW / W;
  const boxH = H * scale;
  const tipRows = series.length;
  // 实测高度公式：border 2 + padding 14 + 日期行 16 + 每行 (19 行高 + 2 间距)
  const TIP_H = 32 + tipRows * 21;
  const px = cursorPx ?? x(hover ?? 0) * scale;
  const toLeft = px < boxW / 2;
  const tipLeft = Math.min(Math.max(toLeft ? px + 14 : px - 14 - TIP_OUTER_W, 4), Math.max(4, boxW - TIP_OUTER_W - 4));
  const tipTop = (() => {
    if (boxH < TIP_H + 12) return 0;
    const py = cursorPy ?? boxH / 2;
    return py < boxH / 2 ? Math.min(boxH - TIP_H - 4, py + 14) : Math.max(4, py - TIP_H - 14);
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
            setCursorPy(null);
          }}
          onPointerMove={(e) => pick(e.clientX, e.clientY)}
          onPointerDown={(e) => pick(e.clientX, e.clientY)}
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
            style={{
              position: "absolute",
              pointerEvents: "none",
              zIndex: 10,
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

// ---------- 环形占比（2026-10-21 改版，学习 01xue.com 后台） ----------
// · 实心饼 → 环形（中心汇总数字），观感更透气
// · 图例 ↔ 扇区悬浮联动高亮（对应扇区加粗、其余变暗）
// · 百分比 2 位小数；极小占比显示 <0.01%
// · 小于 0.5% 的段默认并入「其他」防细缝（单点关键数据传 mergeSmall={false}）

export function Donut({
  items,
  centerLabel,
  mergeSmall = true,
}: {
  items: { label: string; value: number }[];
  centerLabel?: string;
  /** 小于 0.5% 的段并入「其他」（称号体系偏好这类「每一段都是关键数据」的场景传 false） */
  mergeSmall?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return <div className="admin_empty">暂无数据</div>;

  // 小项合并（渲染前算好；沿用 reduce 累积，不做渲染期副作用）
  const small = items.filter((i) => i.value / total < 0.005);
  const list: { label: string; value: number; merged?: boolean }[] = items.filter(
    (i) => i.value / total >= 0.005
  );
  if (!mergeSmall) list.push(...small);
  else if (small.length > 0)
    list.push({ label: `其他（<0.5% 共 ${small.length} 项）`, value: small.reduce((s, i) => s + i.value, 0), merged: true });

  const R = 62;
  const C = 2 * Math.PI * R;
  const SW = 20;
  // 段间留 2px 呼吸缝：弧长扣 2、起点补 1；极小段弧长保底 0.5 防负数
  const segs = list.reduce<
    { list: { idx: number; key: string; color: string; value: number; frac: number; dash: string; offset: number }[]; acc: number }
  >(
    (state, it, idx) => {
      const frac = it.value / total;
      const len = Math.max(0.5, frac * C - 2);
      return {
        list: [
          ...state.list,
          {
            idx,
            key: it.label,
            color: it.merged ? "#6c6c61" : SERIES_COLORS[idx % SERIES_COLORS.length],
            value: it.value,
            frac,
            dash: `${len} ${C - len}`,
            offset: -(state.acc * C) + 1,
          },
        ],
        acc: state.acc + frac,
      };
    },
    { list: [], acc: 0 }
  ).list;

  // 极小但非零的占比显示 <0.01%（toFixed(2) 会显示成 0.00% 造成「没有人用」误读）
  const pct = (f: number) => (f > 0 && f < 0.0001 ? "<0.01%" : `${(f * 100).toFixed(2)}%`);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <svg
        viewBox="0 0 168 168"
        style={{ width: 168, height: 168, flex: "0 0 168px" }}
        role="img"
        aria-label="占比"
      >
        <circle cx="84" cy="84" r={R} fill="none" stroke="#3a3a32" strokeWidth={SW} />
        {segs.map((s) => (
          <circle
            key={s.key}
            cx="84"
            cy="84"
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth={hover === s.idx ? SW + 5 : SW}
            strokeDasharray={s.dash}
            strokeDashoffset={s.offset}
            transform="rotate(-90 84 84)"
            style={{
              opacity: hover === null || hover === s.idx ? 1 : 0.28,
              transition: "stroke-width .12s ease, opacity .12s ease",
              cursor: "pointer",
            }}
            onMouseEnter={() => setHover(s.idx)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x="84" y="80" fontSize="20" fontWeight="bold" fill="#eeeeee" textAnchor="middle">
          {total.toLocaleString("zh-CN")}
        </text>
        <text x="84" y="99" fontSize="11" fill="#75715e" textAnchor="middle">
          {centerLabel ?? "合计"}
        </text>
      </svg>
      <div className="admin_donut_legend">
        {segs.map((s) => (
          <div
            key={s.key}
            className={`admin_donut_row${hover === s.idx ? " hot" : ""}`}
            onMouseEnter={() => setHover(s.idx)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: s.color,
                flex: "0 0 10px",
              }}
            />
            <span className="name" title={s.key}>
              {s.key}
            </span>
            <span className="val">{s.value.toLocaleString("zh-CN")}</span>
            <span className="pct">{pct(s.frac)}</span>
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
