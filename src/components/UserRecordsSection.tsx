"use client";

// 用户主页「纪录」板块（2026-11-06 张老师需求）：动态板块下方新增——
// · 标题行两排筛选器：靠 title 的「总计/初级/中级/高级」级别筛选（默认总计）
//   + 靠右侧的「Time/3BV/s/STNB」指标筛选（默认 Time，margin-left:auto 推到行尾）；
// · 下方照搬纪录页 /records 的进步历程图卡（ChartCard 同一组件、同套 rec_* 样式），
//   显示该玩家个人纪录进步历程（个人纪录严格变优才出点，口径见 lib/records.ts
//   fetchUserRecordCurves）。筛选就地切换不导航（与纪录页 MetricSection 同体验）。
// · 全部曲线无点（从未刷新过任何个人纪录）时由服务端整块隐藏，本组件不渲染空态。
// · BV 格子墙（2026-11-16 张老师需求）：级别筛选选中 初级/中级/高级 时，图表下方
//   出现该级别的 BV 格子墙（形式同对决页各级别 BV 墙：十位分段、每 BV 一格）。
//   每格显示**当前指标筛选**对应的该 BV 个人纪录（时间/3BV/s/STNB 三选一，
//   数据 = lib/records.ts 每 BV 纪录墙，与曲线同源同缓存），底色按该纪录的评级
//   四档渲染（同收集墙 PB 模式：SSS~S 金 / A~B 玫红 / C~E 紫 / F·? 灰），
//   hover 气泡显示纪录值与评级，点击新标签页打开该纪录的录像页。

import { useState } from "react";
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

/** 评级四档底色类（2026-11-16 张老师定：沿用收集墙 PB 模式归档，10px 小格上才分得清）：
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

/**
 * BV 格子墙（级别筛选选中初中高时挂在图表下方）：
 * · 格子全序列 = level_3bv_range 级别区间（getLevel3bvRanges，与收集墙/对决页同源），
 *   跳过数学不可达值（初级 50/52/53）；区间缺行兜底回格子数据并集。
 * · 十位分段行（对决页 .vs_bandrow 形式），行内 flex 排布。
 * · 有纪录的格子 = 链接（新标签页开该纪录录像页，_blank 必配 prefetch=false 铁律）；
 *   无纪录暗格 = span。hover 气泡：3BV 值 + 纪录值与评级（纯 CSS :hover 显隐）。
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
  if (values.length === 0) return null;
  // 十位分段（对决页同形式）：每行 = 同一十位段的可达 BV
  const bands = new Map<number, number[]>();
  for (const b of values) {
    const lo = Math.floor(b / 10) * 10;
    const arr = bands.get(lo);
    if (arr) arr.push(b);
    else bands.set(lo, [b]);
  }

  return (
    <div className="rw_wall" aria-label={`${METRIC_LABELS[metric]}BV 格子墙`}>
      {[...bands.entries()].map(([lo, bvs]) => (
        <div className="rw_band" key={lo}>
          {bvs.map((bv) => {
            const cell = byBv.get(bv);
            const rec = cell ? cellMetric(cell, metric) : null;
            const has = !!rec && rec.v !== null && rec.vid > 0;
            const tip = (
              <i className="rw_tip">
                <b>3BV{" "}={" "}{bv}</b>
                {rec && rec.v !== null ? (
                  <>
                    <span>
                      {METRIC_LABELS[metric]}：
                      <em>{metric === "time" ? scoreTime(rec.v) : fmtMetric(metric, rec.v)}</em>
                      {metric === "time" && " 秒"}
                      　评级：
                      <b className="rw_grade" style={{ color: gradeColor(rec.grade) }}>
                        {rec.grade}
                      </b>
                    </span>
                    {has && <span className="rw_hint">点击查看录像</span>}
                  </>
                ) : (
                  <span>暂无成绩</span>
                )}
              </i>
            );
            const cls = `rw_sq${has && rec ? ` rw_on ${wallTone(rec.grade)}` : ""}`;
            return has && rec ? (
              <Link
                key={bv}
                className={cls}
                href={`/video/${rec.vid}`}
                target="_blank"
                rel="noopener"
                prefetch={false}
                title="查看对应录像"
              >
                {tip}
              </Link>
            ) : (
              <span key={bv} className={cls}>
                {tip}
              </span>
            );
          })}
        </div>
      ))}
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
        {/* BV 格子墙（2026-11-16 张老师需求）：仅初中高级出现（总计无 BV 轴） */}
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
