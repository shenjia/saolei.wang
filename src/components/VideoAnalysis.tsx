// 录像详情页「录像分析」雷达图：本局五维表现（竞技水准 / 移动速度 / 操作效率 / 路线规划 / 有效点击，
// 2026-10-30 五轴改版张老师定——轴位：顶=竞技水准、右上=移动速度、右下=操作效率、
// 左下=路线规划、左上=有效点击）。
// 视觉沿用侧栏「实力」雷达（RadarChart.tsx）：222 视口 / 68 半径 / 8 环网格 / 等级配色，
// 只是数据从「长期实力 8 维」换成「单局表现 5 维」，并把明细挪进 hover 气泡。
//
// 轴数是跟着 data.length 走的（n 自适应），加减轴只改 lib/videoscore.ts 的 radarPointsFrom。
// 2026-10-14 张老师定：去掉「移动」轴（不重要），五围足够；
// 综合 = 其余四轴在「级别 × 模式」组内百分位的加权平均（不再用 STNB）。
//
// ⚠️ 气泡是 HTML 绝对定位 div，不能用 data-tip 的 ::after 方案：
//    SVG 内部元素不支持 CSS 伪元素（content: attr() 取不到），这是 2026-10-14 实现时确认的约束。
// 气泡形态（2026-10-14 张老师定）：锚在标签名下方、只显示一行（数值＋超过 xx% 的玩家，
// 满分显示「全网第一」，口径与「实力」雷达气泡统一）、字号与标签名一致；
// 宽度随内容变化，先隐藏渲染 → 实测宽后钳位定位再显示。
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { VideoAnalysisPoint } from "@/lib/videoanalysis";
// 等级配色与「实力」雷达（RadarChart.tsx）同源：统一在 lib/videoscore.ts 维护，勿单独改
import { gradeColor } from "@/lib/videoscore";

/* 服务端退化为 useEffect（SSR 渲染 useLayoutEffect 会打告警；本组件在录像详情页
   会被 SSR，练习页走 createRoot 纯客户端——两端都要安静） */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const SIZE = 222;
const CENTER = SIZE / 2;
const RADIUS = 68;
const GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];
const GRID_COLOR = "#565549";
const GRID_OUTER_COLOR = "#6a685c";
const LABEL_RADIUS = RADIUS + 20;

// 标签字号（2026-10-14 张老师要求加大，13/8 → 15/10；与 RadarChart.tsx 同源勿单独改）
const LABEL_GRADE_FS = 15;
const LABEL_NAME_FS = 10;
// 轴名基线相对等级基线的下移量（≈ 等级字号，视觉行距与旧版 13/13 一致）
const LABEL_NAME_DY = 15;

// 分项轴「评级+标签」整体偏移（视口 px；偏移只挪文字，轴顶点/热区不动。
// 2026-10-30 五轴改版沿用 2026-10-28 的避让思路：右上/左上两根轴标签下移 10
// 避让顶部「竞技水准」，右下/左下两根再向外侧推开 10；hover 气泡锚点同步用（见下方 effect））
// ⚠️ 轴 key 映射（radarPointsFrom 出的五点）：右上 cps=移动速度 / 右下 thrp=操作效率 /
//    左下 bpp=路线规划 / 左上 ces=有效点击；顶部 stnb=竞技水准（key 锚 stnb 谱系）。
const LABEL_OFFSETS: Record<string, [number, number]> = {
  cps: [10, 10], // 移动速度：右上
  thrp: [10, 10], // 操作效率：右下
  bpp: [-10, 10], // 路线规划：左下
  ces: [-10, 10], // 有效点击：左上
};

// 坐标保留两位：Node(SSR) 与 Chrome(水合) 的三角函数末位可能不同，不一致会触发 hydration mismatch
const f = (v: number) => Math.round(v * 100) / 100;

function polar(index: number, total: number, r: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return [f(CENTER + r * Math.cos(angle)), f(CENTER + r * Math.sin(angle))];
}

// 顶点 i 的扇形热区：覆盖整个视口的楔块，进入该角度范围即 hover。
// ⚠️ 几何按 r=SIZE 画、故意越出视口（角方向最远 333px）：渲染会被视口裁掉，
//    但 .chart 是 overflow:visible（2026-10-15 起标签放大不裁边），越出部分的
//    **命中区不会被裁**——实测缩放后（面板 174/222）五楔块拼成半径 ~174px 的
//    大圆盘盖住结算面板四颗按钮：hover 永远挂着、按钮点不了。
//    所以每块楔块必须 clipPath 钳回 222 视口（见下方 <defs>），只裁命中、不改渲染。
function wedgePath(index: number, total: number): string {
  const step = (Math.PI * 2) / total;
  const a0 = (Math.PI * 2 * index) / total - Math.PI / 2 - step / 2;
  const a1 = a0 + step;
  const r = SIZE;
  const x0 = f(CENTER + r * Math.cos(a0));
  const y0 = f(CENTER + r * Math.sin(a0));
  const x1 = f(CENTER + r * Math.cos(a1));
  const y1 = f(CENTER + r * Math.sin(a1));
  return `M ${CENTER} ${CENTER} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`;
}

function polygonPoints(n: number, r: number): string {
  return Array.from({ length: n }, (_, i) => polar(i, n, r).join(",")).join(" ");
}

/**
 * 录像分析雷达 —— 录像详情页与在线玩结算面板**共用同一个组件**
 * （2026-10-14 张老师定：练习里不许再维护第二份绘制，否则文案/字号/气泡必分叉）。
 *
 * @param fill 紧凑填充模式（在线玩结算面板用，2026-10-15 八期张老师定：
 *   「雷达图的宽度应该顶满面板」）：.vr_wrap 撑满宿主宽、SVG width:100% 等比缩放，
 *   尺寸完全交给宿主（桌面面板内容宽 174 / 移动浮层卡片内容宽 222），不再传固定边长。
 *   默认 false＝录像详情页既有出血布局（尺寸交给 `#page #video_view …` 页面 CSS）。
 *   SVG 内部坐标恒按 222 视图绘制、靠 viewBox 等比缩放，标签字号随尺寸一起等比。
 */
export function VideoAnalysisRadar({
  data,
  fill = false,
  onMount,
}: {
  data: VideoAnalysisPoint[];
  fill?: boolean;
  /** fill 模式专用：DOM 挂载后同步回调（layout 时机）——供宿主在量面板自然高度前
   *  确保雷达已落地（练习页结算面板高度封顶依赖完整高度，2026-10-21） */
  onMount?: () => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // 气泡定位：宽度随内容变化，挂载时先隐藏 → effect 实测气泡/容器宽后写入 left/top 并显示。
  // 用 key={hover} 让每次换轴都重新走一遍「隐藏→定位→显示」，避免换轴瞬间闪现在旧位置。
  // 直接写 DOM 而非 setState：定位是纯外部系统同步（react-hooks/set-state-in-effect）
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  /* 楔块热区裁剪 id（useId 去掉 «» 等非 URL 安全字符；同文档多实例也不会撞） */
  const clipId = "vr_hit_" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  useEffect(() => {
    if (hover === null) return;
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    if (!wrap || !tip) return;
    const place = () => {
      const w = wrap.clientWidth; // 定位父级与 SVG 等宽同起点（出血 margin 挪在 .vr_wrap 上的原因）
      const [lx, ly] = polar(hover, data.length, LABEL_RADIUS);
      // 气泡锚点跟随标签偏移（LABEL_OFFSETS），否则标签挪了气泡留在原位会脱节
      const [ox, oy] = LABEL_OFFSETS[data[hover].key] ?? [0, 0];
      // 气泡顶 = 轴名基线下方 4px；左右默认**与标签水平居中**（textAnchor=middle 下
      // lx+ox 即标签中心），只有半宽越出容器时才钳位（2026-10-31 张老师定）。
      // ⚠️ 换轴时 tip 刚挂载，带 max-width 的折行布局可能在首次读宽后才稳定——
      //    连续两次量宽（间隔一帧），以最终一次为准，防止按旧宽钳位。
      const half = tip.getBoundingClientRect().width / 2;
      tip.style.top = `${((ly + oy + LABEL_NAME_DY + 4) / SIZE) * w}px`;
      tip.style.left = `${Math.min(Math.max(((lx + ox) / SIZE) * w, half + 2), w - half - 2)}px`;
      tip.style.visibility = "visible";
    };
    place();
    const raf = requestAnimationFrame(place); // 折行重排后再校一次
    return () => cancelAnimationFrame(raf);
  }, [hover, data.length]);

  /* DOM 挂载即回调（2026-10-21，方案 B 配套）：练习页结算面板在量自然高度前
     必须确认雷达已落地——layout 时机回调发生在浏览器绘制之前，
     宿主拿到通知后补量的高度即完整高度（服务端退化为 useEffect，见上） */
  useIsoLayoutEffect(() => {
    onMount?.();
  }, [onMount]);

  const n = data.length;
  const points = data.map((d, i) => polar(i, n, (d.percent / 100) * RADIUS));
  const tip = hover === null ? null : data[hover];

  return (
    <div
      className="vr_wrap"
      ref={wrapRef}
      /* fill 模式（练习结算面板）：宽度交给宿主、SVG width:100%（CSS 见 globals
         「紧凑版（练习结算面板…）」块）；录像页沿用页面 CSS 的出血布局 */
      style={fill ? { position: "relative", width: "100%" } : undefined}
    >
      <svg
        className="chart"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="录像分析雷达图"
      >
        <defs>
          {/* 楔块热区命中裁剪：只影响 hit-testing，不影响 overflow:visible 的标签渲染出血 */}
          <clipPath id={clipId}>
            <rect x="0" y="0" width={SIZE} height={SIZE} />
          </clipPath>
        </defs>
        {GRID_RINGS.map((p) => (
          <polygon
            key={p}
            points={polygonPoints(n, (p / 100) * RADIUS)}
            fill="none"
            stroke={p === 100 ? GRID_OUTER_COLOR : GRID_COLOR}
            strokeWidth={p === 100 ? 1.2 : 0.7}
          />
        ))}
        {data.map((_, i) => {
          const [x, y] = polar(i, n, RADIUS);
          return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke={GRID_COLOR} strokeWidth={0.7} />;
        })}
        <polygon
          points={points.map((p) => p.join(",")).join(" ")}
          fill="rgba(102,217,239,0.18)"
          stroke="#66d9ef"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {data.map((d, i) => {
          const active = hover === i;
          const [x, y] = points[i];
          const [lx, ly] = polar(i, n, LABEL_RADIUS);
          // 评级+标签整体偏移（只挪文字；轴顶点圆点/楔块热区不动）
          const [ox, oy] = LABEL_OFFSETS[d.key] ?? [0, 0];
          return (
            <g
              key={d.key}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <path d={wedgePath(i, n)} fill="transparent" pointerEvents="all" clipPath={`url(#${clipId})`} />
              <circle
                cx={x}
                cy={y}
                r={active ? 4 : 2.5}
                fill={active ? "#9cecff" : "#66d9ef"}
                style={{
                  transition: "r .15s ease, fill .15s ease",
                  filter: active ? "drop-shadow(0 0 4px #66d9ef)" : undefined,
                }}
              />
              <text
                x={lx + ox}
                y={ly - 3 + oy}
                textAnchor="middle"
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transform: active ? "scale(1.25)" : "none",
                  transition: "transform .15s ease",
                }}
              >
                <tspan fill={gradeColor(d.grade)} fontSize={LABEL_GRADE_FS} fontWeight="bold">
                  {d.grade}
                </tspan>
                <tspan x={lx + ox} dy={LABEL_NAME_DY} fill={active ? "#a6e22e" : "#8a8878"} fontSize={LABEL_NAME_FS}>
                  {d.name}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div
          key={hover}
          ref={tipRef}
          className="vr_tip"
          style={{ visibility: "hidden" }}
        >
          {/* 2026-10-14 张老师定：与「实力」雷达气泡统一口径用「超过」；满分显示「全网第一」。
              数值（实际数据）单独包 span 上金色（.vr_tip_val），百分比 em 维持原色不变。
              2026-10-15 张老师定：无基准分布（grade="?"）时改提示语，
              不再显示「0.00，超过 0% 的玩家」这种无意义内容。
              2026-10-31 张老师定：所有轴气泡说明分桶（pool，如「高级NF玩家」）；
              路线规划额外带 3BV 桶（pool=「高级小图上的NF玩家」，文案带「在…上」）。 */}
          {tip.grade === "?" ? (
            "参考数据不足，无法评级"
          ) : tip.percent >= 100 ? (
            // 「全网第一」整条金色（.tip_first，globals.css，与 radar_tip 统一）；
            // 2026-10-31 起带池说明（「高级NF玩家中的最强」）
            <span className="tip_first">{tip.pool ? `${tip.pool}中的最强` : "全网第一"}</span>
          ) : (
            // 2026-10-31 张老师定稿：所有轴统一模板，两行——一行数值、一行
            // 「[在{桶}上]超过 xx% 的{池}」；桶前缀（「在小图上」）只有路线规划有
            //（bppPrefix 传「在小图上」等，普通轴 undefined）
            <>
              <span className="vr_tip_val">{tip.disp}</span>
              <br />
              {tip.key === "bpp" && tip.prefix}超过 <em>{tip.percent}%</em> 的{tip.pool ?? "玩家"}
            </>
          )}
        </div>
      )}
    </div>
  );
}
