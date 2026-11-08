// 个人主页「实力」评级标准（2026-11-08 张老师定）：
// 八项数据 × 23 个显式等级，直接展示当前 distribution 快照对应的单向判定临界值。
import { ORDER_DIRECTION, type Level, type Order } from "@/lib/config";
import { score3bvs, scoreTime } from "@/lib/format";
import { getRadarDistribution } from "@/lib/radar";
import { RADAR_GRADES } from "@/lib/radar-standard.mjs";
import { gradeColor } from "@/lib/videoscore";

export const metadata = { title: "评级标准" };

const LEVELS: Level[] = ["beg", "int", "exp", "sum"];
const ORDERS: Order[] = ["time", "3bvs"];
const LEVEL_NAMES: Record<Level, string> = { sum: "总计", exp: "高级", int: "中级", beg: "初级" };
const ORDER_NAMES: Record<Order, string> = { time: "时间", "3bvs": "3BV/s" };
const COLUMNS = LEVELS.flatMap((level) =>
  ORDERS.map((order) => ({ key: `${level}_${order}`, level, order, name: LEVEL_NAMES[level] + ORDER_NAMES[order] })),
);

/** 每格只列一个临界值：SSS～E+ 列本档过线值，F 列进入末档的反向临界值。 */
function thresholdText(dist: number[], index: number, order: Order): string {
  if (dist.length !== RADAR_GRADES.length) return "—";
  const isLast = index === RADAR_GRADES.length - 1;
  const value = dist[isLast ? index - 1 : index];
  if (isLast) return order === "time" ? `> ${scoreTime(value)}` : `< ${score3bvs(value)}`;
  return order === "time" ? `< ${scoreTime(value)}` : `> ${score3bvs(value)}`;
}

export default async function RatingStandardPage() {
  const distribution = await getRadarDistribution();
  const ready = COLUMNS.every((column) => distribution[column.key]?.length === RADAR_GRADES.length);
  return (
    <div id="page" className="rating_page">
      <div className="box text rating_standard">
        <h1>评级标准</h1>
        <p>
          实力图按各项成绩的全网名次独立评级：SSS 为前 3 名，SS+ 为前 10 名，SS 为前 20 名，SS- 为前 30 名，
          S+ 为前 50 名，S 为前 70 名，S- 为前 100 名；第 100 名以后按人数均分为 A+ 至 F 共 16 档。
        </p>
        <p className="rating_note">
          每天 00:30 自动更新判定值。时间单位为秒，数值越小越好；3BV/s 数值越大越好。表内仅列各档临界值，
          同分成绩归入较高档，因此各档人数可能略有差异。
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
                        {thresholdText(distribution[column.key], index, column.order)}
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
