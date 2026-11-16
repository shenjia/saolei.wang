"use client";

// 用户主页「纪录」板块（2026-11-06 张老师需求）：动态板块下方新增——
// · 标题行两排筛选器：靠 title 的「总计/初级/中级/高级」级别筛选（默认总计）
//   + 靠右侧的「Time/3BV/s/STNB」指标筛选（默认 Time，margin-left:auto 推到行尾）；
// · 下方照搬纪录页 /records 的进步历程图卡（ChartCard 同一组件、同套 rec_* 样式），
//   显示该玩家个人纪录进步历程（个人纪录严格变优才出点，口径见 lib/records.ts
//   fetchUserRecordCurves）。筛选就地切换不导航（与纪录页 MetricSection 同体验）。
// · 全部曲线无点（从未刷新过任何个人纪录）时由服务端整块隐藏，本组件不渲染空态。
// · BV 纪录墙（2026-11-16 张老师需求）：级别筛选选中 初级/中级/高级 时，图表下方
//   出现该级别的 BV 纪录墙。**2026-11-16 二次定稿**：水平铺满板块宽度，格子里直接
//   显示成绩（不再只是纯色方格）——格内两行 = BV 值（暗色小字）+ 当前指标筛选项的
//   个人纪录值（按评级四档着色），点击新标签页打开该纪录的录像页。

import { useRef, useState } from "react";
import Link from "next/link";
import { ChartCard, LEVEL_COLORS, type MetricSectionData } from "./RecordsCurves";
import { UNREACHABLE_3BV, type VideoLevel } from "@/lib/config";
import { gradeColor } from "@/lib/videoscore";
import { scoreTime } from "@/lib/format";
import type { UserRecordBvCell, UserRecordBvWalls } from "@/lib/records";

type LevelKey = MetricSectionData["levels"][number]["level"];
type MetricKey = MetricSectionData["metric"];

const LEVEL_ORDER: LevelKey[] = ["total", "beg", "int", "exp"];
/** 指标筛选标签（2026-11-06 张老师定名：Time / 3BV/s / STNB）；图表小标题
 *  用纪录页同款「Time纪录 / 3BV/s纪录 / STNB纪录」（sections.metricName 服务端传入） */
const METRIC_TABS: [MetricKey, string][] = [
  ["time", "Time"],
  ["3bvs", "3BV/s"],
  ["stnb", "STNB"],
];

/** 评级四档色类（2026-11-16 张老师定：沿用收集墙 PB 模式归档）：
 *  SSS~S 金 / A~B 玫红 / C~E 紫 / F·? 灰。尾缀 +/- 不影响档位。
 *  （口径与 BbvCollection.gradeTone 同表，类名按本板块 rw_ 前缀独立，互不干扰） */
function wallTone(grade: string): string {
  const g = grade.replace(/[+-]$/, "");
  if (g === "SSS" || g === "SS" || g === "S") return "rw_gold";
  if (g === "A" || g === "B") return "rw_rose";
  if (g === "C" || g === "D" || g === "E") return "rw_violet";
  return "rw_gray"; // F / ?
}

/** 当前指标在格子里的取值 / 纪录盘 / 评级 */
function cellMetric(cell: UserRecordBvCell, metric: MetricKey) {
  if (metric === "time") return { v: cell.time, vid: cell.timeVid, grade: cell.timeGrade };
  if (metric === "3bvs") return { v: cell.bvs, vid: cell.bvsVid, grade: cell.bvsGrade };
  return { v: cell.stnb, vid: cell.stnbVid, grade: cell.stnbGrade };
}

/** 纪录值显示（与图表 fmtVal 全站口径一致）：time/3bvs ×1000 存储值 ÷1000 三位小数、stnb 原值一位小数 */
function fmtMetric(metric: MetricKey, v: number): string {
  if (metric === "stnb") return v.toFixed(1);
  return (v / 1000).toFixed(3);
}

const METRIC_LABELS: Record<MetricKey, string> = {
  time: "最快时间",
  "3bvs": "最高 3BV/s",
  stnb: "最高 STNB",
};

/** 悬停气泡状态：坐标相对墙容器（不是相对格子）——行首/行尾格子的气泡会被夹回
 *  墙内，永远不会把页面撑出横向滚动条。 */
interface WallTip {
  x: number;
  y: number;
  /** 上方空间不足（第一行）时翻到格子下方弹出 */
  below: boolean;
  bv: number;
  v: number | null;
  grade: string;
  vid: number;
}

/**
 * BV 纪录墙（级别筛选选中初中高时挂在图表下方）：
 * · 格子全序列 = level_3bv_range 级别区间（getLevel3bvRanges，与收集墙/对决页同源），
 *   跳过数学不可达值（初级 50/52/53）；区间缺行兜底回格子数据并集。
 * · **一行 10 格**（十位分段行，个位对齐，2026-11-16 张老师定）：每行都是
 *   `repeat(10, 1fr)` 的 grid，10 列铺满板块全宽；末段不足 10 个仍按 10 列排位。
 * · 每格两行：上 BV 值（暗色小字，定位用）、下该 BV 的个人纪录值（评级四档显色），
 *   格底/描边同档微着色；无纪录 = 暗格（只显示 BV 值，一眼看出收集缺口）。
 *   无纪录格与有纪录格**同高**：值槽恒占位（空值填 nbsp），行高不随有无成绩变化。
 * · 有纪录的格子 = 链接（新标签页开该纪录录像页，_blank 必配 prefetch=false 铁律）。
 * · 气泡用 JS 定位（纯 CSS 无法在网格里按行首/行尾夹紧）：朝上弹出（2026-11-11
 *   全站气泡口径），第一行空间不足时翻到格子下方。
 */
function RecordBvWall({
  level,
  metric,
  cells,
  range,
}: {
  level: "beg" | "int" | "exp";
  metric: MetricKey;
  cells: UserRecordBvCell[];
  range?: { min: number; max: number };
}) {
  const byBv = new Map(cells.map((c) => [c.bv, c]));
  // 全序列（区间缺行兜底：退回本人已达成 BV 的并集，只画有数据的格）
  const dead = new Set(UNREACHABLE_3BV[level as VideoLevel] ?? []);
  let values: number[];
  if (range && range.min <= range.max) {
    values = [];
    for (let b = range.min; b <= range.max; b++) if (!dead.has(b)) values.push(b);
  } else {
    values = cells.map((c) => c.bv);
  }
  const wallRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<WallTip | null>(null);

  if (values.length === 0) return null;
  // 十位分段（一行 10 格，个位对齐；末段不足 10 个仍占前几列，格子宽度不变）
  const bands = new Map<number, number[]>();
  for (const b of values) {
    const lo = Math.floor(b / 10) * 10;
    const arr = bands.get(lo);
    if (arr) arr.push(b);
    else bands.set(lo, [b]);
  }

  const showTip = (
    el: HTMLElement,
    bv: number,
    v: number | null,
    grade: string,
    vid: number
  ) => {
    const wall = wallRef.current;
    if (!wall) return;
    const wr = wall.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    // 气泡按 ~208px 宽估半宽夹紧（文案最长一行 = 指标名+值+评级）
    const half = 104;
    const cx = cr.left + cr.width / 2 - wr.left;
    const x = Math.min(Math.max(cx, half), Math.max(half, wr.width - half));
    const top = cr.top - wr.top;
    const below = top < 46;
    setTip({ x, y: below ? cr.bottom - wr.top : top, below, bv, v, grade, vid });
  };

  return (
    <div
      className="rw_wall"
      ref={wallRef}
      aria-label={`${METRIC_LABELS[metric]}BV 纪录墙`}
      onMouseLeave={() => setTip(null)}
    >
      {[...bands.entries()].map(([lo, bvs]) => (
        <div className="rw_band" key={lo}>
          {bvs.map((bv) => {
            const cell = byBv.get(bv);
            const rec = cell ? cellMetric(cell, metric) : null;
            const v = rec?.v ?? null;
            const grade = rec?.grade ?? "";
            const vid = rec?.vid ?? 0;
            const has = v !== null && vid > 0;
            const cls = `rw_sq${v !== null ? ` rw_on ${wallTone(grade)}` : ""}`;
            // 值槽恒占位：无成绩填 nbsp —— 暗格与有成绩格同高，行高不抖
            const body = (
              <>
                <em className="rw_bv">{bv}</em>
                <b className="rw_val">
                  {v !== null ? (metric === "time" ? scoreTime(v) : fmtMetric(metric, v)) : "\u00a0"}
                </b>
              </>
            );
            const enter = (e: React.SyntheticEvent<HTMLElement>) =>
              showTip(e.currentTarget, bv, v, grade, vid);
            return has ? (
              <Link
                key={bv}
                className={cls}
                href={`/video/${vid}`}
                target="_blank"
                rel="noopener"
                prefetch={false}
                onMouseEnter={enter}
                onFocus={enter}
                onBlur={() => setTip(null)}
              >
                {body}
              </Link>
            ) : (
              <span key={bv} className={cls} onMouseEnter={enter}>
                {body}
              </span>
            );
          })}
        </div>
      ))}
      {tip && (
        <i className={`rw_tip${tip.below ? " rw_tip_b" : ""}`} style={{ left: tip.x, top: tip.y }}>
          <b className="rw_tip_bv">3BV {tip.bv}</b>
          {tip.v !== null ? (
            <>
              <span>
                {METRIC_LABELS[metric]}：
                <em>{metric === "time" ? scoreTime(tip.v) : fmtMetric(metric, tip.v)}</em>
                {metric === "time" && " 秒"}　评级：
                <b className="rw_grade" style={{ color: gradeColor(tip.grade) }}>
                  {tip.grade}
                </b>
              </span>
              {tip.vid > 0 && <span className="rw_hint">点击查看录像</span>}
            </>
          ) : (
            <span>暂无成绩</span>
          )}
        </i>
      )}
    </div>
  );
}

export function UserRecordsSection({
  sections,
  walls,
  ranges,
}: {
  sections: MetricSectionData[];
  /** 每 BV 纪录墙（lib/records.ts 同缓存带出；总计级别不渲染墙） */
  walls?: UserRecordBvWalls;
  /** 级别 3BV 区间（level_3bv_range，与收集墙同源；缺行时墙退回已达成并集） */
  ranges?: Partial<Record<VideoLevel, { min: number; max: number }>>;
}) {
  const [level, setLevel] = useState<LevelKey>("total");
  const [metric, setMetric] = useState<MetricKey>("time");
  const sec = sections.find((s) => s.metric === metric) ?? sections[0];
  const cur = sec.levels.find((l) => l.level === level) ?? sec.levels[0];

  return (
    <div className="box" id="user_records">
      <div className="news_head">
        <h1 className="gray">纪录</h1>
        {/* 级别筛选：紧贴标题（与动态板块 tabs 同构 div.news_tabs.ranking_tabs） */}
        <div className="news_tabs ranking_tabs" aria-label="级别筛选">
          {LEVEL_ORDER.map((lv) => {
            const l = sec.levels.find((x) => x.level === lv);
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
        {/* 指标筛选：margin-left:auto 推到行尾（globals.css .user_record_metric_tabs；≤768 回落左对齐） */}
        <div className="news_tabs ranking_tabs user_record_metric_tabs" aria-label="指标筛选">
          {METRIC_TABS.map(([m, label]) =>
            m === metric ? (
              <span key={m} className="current">
                {label}
              </span>
            ) : (
              <a
                key={m}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMetric(m);
                }}
              >
                {label}
              </a>
            )
          )}
        </div>
      </div>
      <div className="rec_group">
        <ChartCard
          key={`${metric}-${level}`}
          chart={{ metric, metricName: sec.metricName, points: cur?.points ?? [] }}
          levelName={cur?.levelName ?? ""}
          color={LEVEL_COLORS[level]}
        />
        {/* BV 纪录墙（2026-11-16 张老师需求）：仅初中高级出现（总计无 BV 轴） */}
        {level !== "total" && walls && (
          <RecordBvWall
            key={`wall-${metric}-${level}`}
            level={level}
            metric={metric}
            cells={walls[level] ?? []}
            range={ranges?.[level]}
          />
        )}
      </div>
    </div>
  );
}
