// 个人主页「实力」评级标准（2026-11-08 张老师定）：
// 八项数据 × 23 个显式等级，直接展示当前 distribution 快照对应的实际判定区间。
import { ORDER_DIRECTION, type Level, type Order } from "@/lib/config";
import { score3bvs, scoreTime } from "@/lib/format";
import { getRadarDistribution } from "@/lib/radar";
import { RADAR_GRADES } from "@/lib/radar-standard.mjs";
import { gradeColor } from "@/lib/videoscore";

export const metadata = { title: "评级标准" };

const LEVELS: Level[] = ["sum", "exp", "int", "beg"];
const ORDERS: Order[] = ["time", "3bvs"];
const LEVEL_NAMES: Record<Level, string> = { sum: "总计", exp: "高级", int: "中级", beg: "初级" };
const ORDER_NAMES: Record<Order, string> = { time: "时间", "3bvs": "3BV/s" };
const COLUMNS = ORDERS.flatMap((order) =>
  LEVELS.map((level) => ({ key: `${level}_${order}`, level, order, name: LEVEL_NAMES[level] + ORDER_NAMES[order] })),
);

/** 阈值是从强到弱的档位末位；同分归入较高档，所以下一档不包含上一档阈值。 */
function intervalText(dist: number[], index: number, order: Order): string {
  if (dist.length !== RADAR_GRADES.length) return "—";
  const current = dist[index];
  if (index === 0) {
    return order === "time" ? `≤ ${scoreTime(current)}` : `≥ ${score3bvs(current)}`;
  }
  const previous = dist[index - 1];
  if (index === RADAR_GRADES.length - 1) {
    return order === "time" ? `> ${scoreTime(previous)}` : `< ${score3bvs(previous)}`;
  }
  // 相同阈值意味着本档没有独立成绩区间，同分全部由前面的较高档接住。
  if (previous === current) return "—";
  if (order === "time") return `${scoreTime(previous + 1)} ～ ${scoreTime(current)}`;
  return `${score3bvs(current)} ～ ${score3bvs(previous - 1)}`;
}

export default async function RatingStandardPage() {
  const distribution = await getRadarDistribution();
  const ready = COLUMNS.every((column) => distribution[column.key]?.length === RADAR_GRADES.length);
  return (
    <div id="page" className="rating_page">
      <div className="box text rating_standard">
        <h1>评级标准</h1>
        <p>
          实力图按各项成绩的全网名次独立评级：SSS 为前 10 名，SS+ 为前 20 名，SS 为前 30 名，SS- 为前 40 名，
          S+ 为前 60 名，S 为前 80 名，S- 为前 100 名；第 100 名以后按人数均分为 A+ 至 F 共 16 档。
        </p>
        <p className="rating_note">
          每天 00:30 自动更新判定值。时间单位为秒，数值越小越好；3BV/s 数值越大越好。表内为各档实际判定区间，
          “—”表示同分导致该档暂无独立区间；同分成绩归入较高档，因此各档人数可能略有差异。
        </p>
        {ready ? (
          <div className="rating_table_wrap">
            <table className="table rating_table" cellPadding={0} cellSpacing={0}>
              <thead>
                <tr>
                  <th className="grade_col">等级</th>
                  {COLUMNS.map((column) => (
                    <th key={column.key}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RADAR_GRADES.map((grade, index) => (
                  <tr key={grade}>
                    <th className="grade_col" style={{ color: gradeColor(grade) }}>
                      {grade}
                    </th>
                    {COLUMNS.map((column) => (
                      <td key={column.key} className={ORDER_DIRECTION[column.order] === "asc" ? "time_value" : "bvs_value"}>
                        {intervalText(distribution[column.key], index, column.order)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rating_pending">新版评级分布正在生成，请稍后查看。</p>
        )}
      </div>
    </div>
  );
}
