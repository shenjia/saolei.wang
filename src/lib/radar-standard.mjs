// 个人主页「实力」雷达的 23 档评级唯一口径（2026-11-08 张老师定）。
// 与录像详情页五轴评级（src/lib/videoscore.ts 的 9 主档 + 档内插值）完全独立，互不改用。
//
// 名次边界：SSS 前 3；SS+ 前 10；SS 前 20；SS- 前 30；
// S+ 前 50；S 前 70；S- 前 100。第 100 名后的玩家再均分为
// A+ / A / A- … E+ / E / E- / F 共 16 档。每列 distribution 按此顺序存 23 个阈值。

export const RADAR_GRADES = [
  "SSS",
  "SS+", "SS", "SS-",
  "S+", "S", "S-",
  "A+", "A", "A-",
  "B+", "B", "B-",
  "C+", "C", "C-",
  "D+", "D", "D-",
  "E+", "E", "E-",
  "F",
];

export const RADAR_FIXED_RANKS = [3, 10, 20, 30, 50, 70, 100];
export const RADAR_REMAINING_GRADES = 16;

// 绘图半径：保留原九主档锚点（SSS100 / SS90 / S80 / A70 / B60 / C50 / D35 / E15 / F5），
// +/- 子档插在相邻主档之间。它只决定雷达形状，不代表真实超越人数（气泡另算 beatPct）。
export const RADAR_GRADE_PERCENTS = [
  100,
  95, 90, 86.7,
  83.3, 80, 76.7,
  73.3, 70, 66.7,
  63.3, 60, 56.7,
  53.3, 50, 45,
  41.7, 35, 28.3,
  21.7, 15, 10,
  5,
];

/**
 * 由该维度有成绩人数生成 23 档的名次下界（1 基，含末位）。
 * 例：SSS 取第 3 名成绩；A+ 取第 100 + floor((N-100)/16) 名成绩。
 * 不足 100 人时后续边界钳到 N，重复阈值对应空档，判级仍稳定落在可达到的最高档。
 */
export function radarDistributionRanks(total) {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`无效成绩人数: ${total}`);
  const ranks = RADAR_FIXED_RANKS.map((rank) => Math.min(rank, total));
  for (let i = 1; i <= RADAR_REMAINING_GRADES; i++) {
    ranks.push(total <= 100 ? total : 100 + Math.floor(((total - 100) * i) / RADAR_REMAINING_GRADES));
  }
  ranks[ranks.length - 1] = total;
  return ranks;
}

/** 从强到弱找首个过线档；比 F 阈值还差也钳在 F。 */
export function radarPosition(score, dist, direction) {
  for (let i = 0; i < dist.length; i++) {
    if (direction === "desc" ? score >= dist[i] : score <= dist[i]) return i;
  }
  return Math.min(dist.length, RADAR_GRADES.length - 1);
}

export function radarGrade(score, dist, direction) {
  if (!score || dist.length !== RADAR_GRADES.length) return "?";
  return RADAR_GRADES[radarPosition(score, dist, direction)];
}

export function radarPercent(score, dist, direction) {
  if (!score || dist.length !== RADAR_GRADES.length) return 0;
  return RADAR_GRADE_PERCENTS[radarPosition(score, dist, direction)];
}
