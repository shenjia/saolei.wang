"use client";

// 纪录页左侧「纪录」大板块（2026-10-28 三轮，张老师口径）：
// · 板块 = 标准卡片（.box）+ page_head（h1「纪录」左 + 级别筛选器右，复刻排行页页头）；
//   筛选器 = 总计/初级/中级/高级（.ranking_tabs 复用；总计为 sum_time 三级齐全口径，
//   无历史事件流只出当前纪录单点卡片）。
// · 每级别三图（时间 / 3BV/s / STNB）纪录演变；级别专属色：
//   总计金 #fdc61a / 初级绿 #a6e22e / 中级橙 #f79646 / 高级金 #fdc61a。
// · 卡片小标题「XX纪录：xx.xx 人名 性别 军衔徽章+军衔名 创造于日期（距今 N 天）」
//   ——纪录值在人名之前；人名+性别+军衔严格复刻首页尺寸（14px 标准字号，无 small 变体）。
// · 每点 hover 浮层：日期（距今天数）/ 纪录值 / 创造者（人名+性别+军衔强制同行）/ 保持时长。
// · 图表横向自适应（三轮张老师要求）：全宽铺开优先，点密时压缩每点横向格宽
//   （下限 6px），只有 >600 点的极端情况才转横向滚动——中级/高级不再出滚动条。
// · 移动端触摸（八轮 2026-10-28 张老师反馈）：①气泡垂直位置随触点翻转
//   （上半区沉底/下半区贴顶），手指不再挡气泡；②触摸选中在松手后保持
//   （pointerleave 只对鼠标清 hover），滚动或切级别才清除——修「点了没气泡」。
// · 九轮（2026-10-28）：移动端标题与筛选器同行（CSS 侧）；窄容器图表加高 220。
// · 十轮（同日，张老师定）：标题行改首页新闻板块同款 .news_head——保证标题与
//   筛选器同行的权威实现（组件级 flex wrap，不受 page_head 移动端堆叠规则影响），
//   桌面/移动断点补丁随之全退，间距用 news_head 自带 19.5px 首页节奏。
// · 「距今 N 天」按浏览器本地时间实时算——SSR 与客户端可能跨天差 1，
//   该 span 挂 suppressHydrationWarning（绝对日期不受影响）。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AvatarCell } from "./Cells";
import { TitleBadge } from "./TitleBadge";
import type { TitlePair } from "@/lib/title-system";

export interface CurvePoint {
  /** 录像 id（点击跳 /video/<v>；总计无对应录像=0 不渲染链接） */
  v: number;
  /** 创造者 uid（跳 /user/<u>） */
  u: number;
  n: string;
  /** 创造者性别（0=女 1=男，首页 AvatarCell 同口径） */
  s: number;
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

/** 级别 key（四轮：总计/初级/中级/高级四档筛选） */
type LevelKey = "total" | "beg" | "int" | "exp";

/** 级别专属色（2026-10-28 张老师定：绿橙金；总计=金） */
const LEVEL_COLORS: Record<LevelKey, string> = {
  total: "#fdc61a",
  beg: "#a6e22e",
  int: "#f79646",
  exp: "#fdc61a",
};

const PAD_T = 14;
const PAD_B = 22;
const PAD_X = 8;
/** 图高：桌面 150 / 窄容器（移动端单列）220——见 ChartCard 内 H 的计算（九轮） */
/** 自适应压缩下限与滚动兜底（三轮：不许出滚动条；>600 点极罕见才滚） */
const PER_POINT_MIN = 6;
const SCROLL_THRESHOLD = 600;

/** 纪录值显示：与全站口径一致（time 2 位小数秒 / 3bvs 3 位小数 / stnb 1 位小数=STNB 榜同款） */
function fmtVal(metric: CurveChart["metric"], v: number): string {
  if (metric === "time") return (v / 1000).toFixed(2);
  if (metric === "3bvs") return (v / 1000).toFixed(3);
  return v.toFixed(1);
}

/** 轴/浮层通用格式（Y 轴刻度 2 位足够读） */
function fmtAxis(metric: CurveChart["metric"], v: number): string {
  if (metric === "3bvs") return (v / 1000).toFixed(2);
  if (metric === "stnb") return v.toFixed(1);
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

function ChartCard({
  chart,
  levelName,
  color,
}: {
  chart: CurveChart;
  levelName: string;
  color: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(600);
  // 九轮（2026-10-28 张老师要求）：移动端单列模式图表加高——判据用视口媒体查询，
  // 不用容器宽：全站移动端有 #page zoom 缩放体系（页面按 ~600px 布局再整体缩小），
  // 容器宽恒在 ~518 上下浮动，用它会漏判/误判；≤768 与单列化断点同口径
  const [narrow, setNarrow] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [tipLeft, setTipLeft] = useState(0);
  // 八轮（2026-10-28 张老师反馈移动端）：气泡垂直位置随触点翻转——手指按在图表
  // 上半区时气泡沉底、下半区时贴顶，避免触点（手指）正好压住气泡
  const [tipBelow, setTipBelow] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBoxW(el.clientWidth || 600);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mq = window.matchMedia("(max-width: 768px)");
    const mqUpdate = () => setNarrow(mq.matches);
    mqUpdate();
    mq.addEventListener("change", mqUpdate);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", mqUpdate);
    };
  }, []);

  const pts = chart.points;
  const n = pts.length;

  // 九轮（2026-10-28 张老师要求）：移动端单列模式图表加高（150→220），
  // 手指有更多可操作纵向空间；缩放体系下 220 布局 px 在 0.65~0.76 档
  // 实际 ≈ 145~165 物理 px（旧 150 → ~100），增益明显。SSR/首帧走桌面高，挂载后校准
  const H = narrow ? 220 : 150;

  if (n < 2) {
    // 单点（总计当前纪录）：完整标题行 + 居中说明（无演变曲线）
    const only = pts[0];
    return (
      <div className="rec_card">
        <div className="rec_head">
          <span className="rec_name">
            {levelName}
            {chart.metricName}：
          </span>
          {only ? (
            <>
              {only.v > 0 ? (
                <Link className="rec_val" href={`/video/${only.v}`} title="点击查看该录像">
                  {fmtVal(chart.metric, only.y)}
                </Link>
              ) : (
                <span className="rec_val">{fmtVal(chart.metric, only.y)}</span>
              )}
              <span className="rec_meta">　</span>
              <AvatarCell id={only.u} name={only.n} sex={only.s} link className="rec_user" gender="small" />
              <TitleBadge title={only.t.m} classic={only.t.c} link />
              <span className="rec_meta">
                　创造于 {fmtDate(only.x)}（距今{" "}
                <span suppressHydrationWarning>{daysAgo(only.x)}</span> 天）
              </span>
            </>
          ) : (
            <span className="rec_meta">暂无数据</span>
          )}
        </div>
        <div className="rec_chart_empty">暂无演变数据（当前纪录快照）</div>
      </div>
    );
  }

  // 横向自适应：全宽铺开优先；点密时压缩格宽（≥6px/点）；仅极端点数才横向滚动
  const fitPer = boxW / n;
  const W =
    n > SCROLL_THRESHOLD
      ? n * 26
      : Math.max(boxW, Math.min(n * 26, n * Math.max(PER_POINT_MIN, fitPer)));
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
    // 浮层宽度 auto（min 200 / max 260），右缘防裁按 262 估算
    let tl = visX + 12;
    if (tl + 262 > vw) tl = visX - 262 - 12;
    setTipLeft(Math.min(Math.max(4, tl), Math.max(4, vw - 266)));
    // 触点在图表上半区 → 气泡放底部；下半区 → 贴顶（鼠标 hover 同样受益：
    // 光标在顶部时气泡不再盖住光标所指的数据点）
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    setTipBelow(sy < H / 2);
    setHover(best);
  };

  const hp = hover !== null ? pts[hover] : null;

  return (
    <div className="rec_card">
      <div className="rec_head">
        <span className="rec_name">
          {levelName}
          {chart.metricName}：
        </span>
        <Link className="rec_val" href={`/video/${last.v}`} title="点击查看该录像">
          {fmtVal(chart.metric, last.y)}
        </Link>
        <span className="rec_meta">　</span>
        {/* 人名+军衔完全复刻首页（AvatarCell 名字链接+性别图标 + TitleBadge 徽章；14px 标准尺寸） */}
        <AvatarCell id={last.u} name={last.n} sex={last.s} link className="rec_user" gender="small" />
        <TitleBadge title={last.t.m} classic={last.t.c} link />
        <span className="rec_meta">
          　创造于 {fmtDate(last.x)}（距今 <span suppressHydrationWarning>{daysAgo(last.x)}</span> 天）
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
          aria-label={`${levelName}${chart.metricName}演变`}
          style={{ touchAction: "pan-y" }}
          onPointerMove={pick}
          onPointerDown={pick}
          // 触摸松手时浏览器会补发 pointerleave（触摸指针随 up 隐式释放），
          // 直接清掉会让「点一下」的气泡闪现即逝、看起来像根本没出现——
          // 触摸交互的选中保持到滚动/切换级别才清；鼠标 hover 仍随移出消失
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch") setHover(null);
          }}
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
            fill={color}
            fillOpacity="0.13"
          />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
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
                fill={color}
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
          <div
            className="rec_tip"
            style={{
              left: tipLeft,
              top: tipBelow ? "auto" : 6,
              bottom: tipBelow ? 6 : undefined,
            }}
          >
            <div className="d">
              {fmtDate(hp.x)}（距今 <span suppressHydrationWarning>{daysAgo(hp.x)}</span> 天）
            </div>
            <div className="row">
              <span>纪录值</span>
              <b>{fmtVal(chart.metric, hp.y)}</b>
            </div>
            <div className="row">
              <span>创造者</span>
              {/* 强制同行：人名+性别+军衔不换行（三轮张老师要求） */}
              <span className="who">
                <AvatarCell id={hp.u} name={hp.n} sex={hp.s} link gender="small" />
                <TitleBadge title={hp.t.m} classic={hp.t.c} />
              </span>
            </div>
            <div className="row">
              <span>保持时长</span>
              <b className="hold">
                {hover === n - 1 ? "至今" : holdText(hp.x, pts[hover! + 1].x)}
              </b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 「纪录」大板块：news_head（h1 + 级别筛选器）+ 当前级别三图（复刻首页新闻板块标题行） */
/** 左栏三板块数据：一个指标板块 = 一个图卡 × 四级别筛选 */
export interface MetricSectionData {
  metric: "time" | "3bvs" | "stnb";
  metricName: string;
  /** 四级别各自的点集（levelName 用于筛选器标签） */
  levels: { level: "total" | "beg" | "int" | "exp"; levelName: string; points: CurvePoint[] }[];
}

const LEVEL_ORDER: MetricSectionData["levels"][number]["level"][] = ["total", "beg", "int", "exp"];

/** 单板块：h2 标题 + 级别筛选器 + 当前级别的图表卡（2026-10-28 四轮张老师定：
 *  左栏拆三板块「时间纪录/3BV/s纪录/STNB纪录」，各自带「总计/初级/中级/高级」筛选。
 *  十轮（同日）：标题行改首页新闻板块同款 .news_head——张老师明确要求参考首页新闻
 *  版式且保证标题与筛选器同行。.news_head 是全站组件级 flex wrap 样式，不受
 *  ≤768 通用 .page_head column 堆叠规则影响，两端天然同行（放不下才 wrap 兜底）；
 *  之前为 page_head 打的桌面/移动两个断点补丁全部退掉 */
function MetricSection({ section }: { section: MetricSectionData }) {
  const [level, setLevel] = useState<MetricSectionData["levels"][number]["level"]>("total");
  const byLevel = new Map(section.levels.map((l) => [l.level, l]));
  const cur = byLevel.get(level) ?? section.levels.find((l) => l.points.length > 0) ?? section.levels[0];

  return (
    <div className="box records_box">
      <div className="news_head">
        <h1 className={"records_sec_title" + (section.metric === "time" ? " gold" : "")}>{section.metricName}</h1>
        <div className="news_tabs ranking_tabs" aria-label={`${section.metricName}级别筛选`}>
          {LEVEL_ORDER.map((lv) => {
            const l = byLevel.get(lv);
            if (!l) return null;
            return lv === level ? (
              <span key={lv} className="current">
                {l.levelName}
              </span>
            ) : (
              <a
                key={lv}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setLevel(lv);
                }}
              >
                {l.levelName}
              </a>
            );
          })}
        </div>
      </div>
      <div className="rec_group">
        <ChartCard
          key={`${section.metric}-${level}`}
          chart={{ metric: section.metric, metricName: section.metricName, points: cur?.points ?? [] }}
          levelName={cur?.levelName ?? ""}
          color={LEVEL_COLORS[level]}
        />
      </div>
    </div>
  );
}

export function RecordsCurves({ sections }: { sections: MetricSectionData[] }) {
  return (
    <>
      {sections.map((s) => (
        <MetricSection key={s.metric} section={s} />
      ))}
    </>
  );
}
