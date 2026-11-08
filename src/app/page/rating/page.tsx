// 个人主页「实力」评级标准（2026-11-08 张老师定）：
// 八项数据 × 23 个显式等级，直接展示当前 distribution 快照对应的单向判定临界值。
import { ORDER_DIRECTION, type Level, type Order } from "@/lib/config";
import { prisma } from "@/lib/db";
import { score3bvs, scoreTime } from "@/lib/format";
import { getRadarDistribution } from "@/lib/radar";
import { RADAR_FIXED_RANKS, RADAR_GRADES, radarDistributionRanks } from "@/lib/radar-standard.mjs";
import { gradeColor } from "@/lib/videoscore";
import { unstable_cache } from "next/cache";

export const metadata = { title: "评级标准" };

// 仅缓存本页正文数据 1 小时；全站顶栏读取登录态，不能 force-static 整页以免串用户。
const getRatingStandardData = unstable_cache(
  async () => {
    const [distribution, snapshot] = await Promise.all([
      getRadarDistribution(),
      prisma.distribution.findFirst({ select: { size: true }, orderBy: { id: "desc" } }),
    ]);
    return { distribution, total: Number(snapshot?.size ?? 0) };
  },
  ["rating-standard-page-v2"],
  { revalidate: 3600 },
);

const LEVELS: Level[] = ["beg", "int", "exp", "sum"];
const ORDERS: Order[] = ["time", "3bvs"];
const LEVEL_NAMES: Record<Level, string> = { sum: "总计", exp: "高级", int: "中级", beg: "初级" };
const ORDER_NAMES: Record<Order, string> = { time: "时间", "3bvs": "3BV/s" };
const COLUMNS = LEVELS.flatMap((level) =>
  ORDERS.map((order) => ({ key: `${level}_${order}`, level, order, name: LEVEL_NAMES[level] + ORDER_NAMES[order] })),
);

/** 每格只列一个临界值：SSS～E+ 列本档过线值，F 列进入末档的反向临界值。 */
function thresholdParts(dist: number[], index: number, order: Order): { operator: string; value: string } {
  if (dist.length !== RADAR_GRADES.length) return { operator: "", value: "—" };
  const isLast = index === RADAR_GRADES.length - 1;
  const value = dist[isLast ? index - 1 : index];
  return {
    operator: order === "time" ? (isLast ? ">" : "<") : isLast ? "<" : ">",
    value: order === "time" ? scoreTime(value) : score3bvs(value),
  };
}

export default async function RatingStandardPage() {
  const { distribution, total } = await getRatingStandardData();
  const ranks = total > 0 ? radarDistributionRanks(total) : [];
  const rangeParts = RADAR_GRADES.map((_, index) => {
    if (index < RADAR_FIXED_RANKS.length) {
      return { prefix: "前", value: String(RADAR_FIXED_RANKS[index]), suffix: "名" };
    }
    if (!ranks.length) return { prefix: "", value: "—", suffix: "" };
    return { prefix: "前", value: ((ranks[index] / total) * 100).toFixed(2), suffix: "%" };
  });
  const ready = COLUMNS.every((column) => distribution[column.key]?.length === RADAR_GRADES.length);
  return (
    <div id="page" className="rating_page">
      <div className="box text rating_standard">
        <h1>评级标准</h1>
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
                  <th className="range_col">范围</th>
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
                    <td className="range_col">
                      {rangeParts[index].prefix}{" "}
                      <span className="range_number">{rangeParts[index].value}</span>{" "}
                      {rangeParts[index].suffix}
                    </td>
                    {COLUMNS.map((column) => {
                      const threshold = thresholdParts(distribution[column.key], index, column.order);
                      const isTime = ORDER_DIRECTION[column.order] === "asc";
                      return (
                        <td key={column.key} className={isTime ? "time_value" : "bvs_value"}>
                          <span className="threshold_operator">{threshold.operator}</span>{" "}
                          <span className={isTime ? "time_number" : "bvs_number"}>{threshold.value}</span>
                        </td>
                      );
                    })}
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
