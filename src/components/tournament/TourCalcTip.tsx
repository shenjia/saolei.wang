// 比赛成绩「计算过程」气泡（2026-11-22 从详情页 page.tsx 抽出共享）：
// 排行榜前10 / 右栏「成绩」最好成绩 / 动态板块成绩数字（张老师 2026-11-22 需求）
// 三处共用；各级别一行、级别名绿/橙/金，末行总计金色，保底直接写在过程中。
// 渲染结构同 .comp_calc 实元素气泡（hover 触发由锚点类 comp_score_tip 承担）。

import { LEVEL_NAMES, type Level } from "@/lib/config";
import { fmtTourScore, type TourMetricKey } from "@/lib/tour-metric";

/* 气泡级别配色（2026-11-22 张老师定）：初级绿/中级橙/高级金，同 .comp_lv_plain */
const LV_TIP_COLOR: Record<string, string> = {
  beg: "comp_calc_beg",
  int: "comp_calc_int",
  exp: "comp_calc_exp",
};

export function TourCalcTip({
  calc,
  metric,
  score,
}: {
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[];
  metric: TourMetricKey;
  score: number;
}) {
  return (
    <span className="comp_calc">
      {calc.map((seg) => {
        const lvName = seg.lv in LEVEL_NAMES ? LEVEL_NAMES[seg.lv as Level] : seg.lv;
        const fillPart =
          seg.fill > 0 && seg.floorScore > 0
            ? ` +${seg.fill}×保底${fmtTourScore(metric, seg.floorScore)}`
            : "";
        return (
          <span key={seg.lv} className="comp_calc_row">
            <i className={"comp_calc_lv" + (seg.lv in LV_TIP_COLOR ? ` ${LV_TIP_COLOR[seg.lv]}` : "")}>
              {lvName}
            </i>
            {`${seg.n}盘 ${fmtTourScore(metric, seg.real)}${fillPart}`}
          </span>
        );
      })}
      <span className="comp_calc_row comp_calc_total">总计 {fmtTourScore(metric, score)}</span>
    </span>
  );
}
