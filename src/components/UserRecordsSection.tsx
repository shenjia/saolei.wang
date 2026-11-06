"use client";

// 用户主页「纪录」板块（2026-11-06 张老师需求）：动态板块下方新增——
// · 标题行两排筛选器：靠 title 的「总计/初级/中级/高级」级别筛选（默认总计）
//   + 靠右侧的「Time/3BV/s/STNB」指标筛选（默认 Time，margin-left:auto 推到行尾）；
// · 下方照搬纪录页 /records 的进步历程图卡（ChartCard 同一组件、同套 rec_* 样式），
//   显示该玩家个人纪录进步历程（个人纪录严格变优才出点，口径见 lib/records.ts
//   fetchUserRecordCurves）。筛选就地切换不导航（与纪录页 MetricSection 同体验）。
// · 全部曲线无点（从未刷新过任何个人纪录）时由服务端整块隐藏，本组件不渲染空态。

import { useState } from "react";
import { ChartCard, LEVEL_COLORS, type MetricSectionData } from "./RecordsCurves";

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

export function UserRecordsSection({ sections }: { sections: MetricSectionData[] }) {
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
      </div>
    </div>
  );
}
