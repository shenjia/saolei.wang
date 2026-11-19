// 个人主页「实力」雷达的 23 档评级唯一口径（2026-11-08 张老师定；2026-11-09 A+～F 边界改版）。
// 与录像详情页五轴评级（src/lib/videoscore.ts 的 9 主档 + 档内插值）完全独立，互不改用。
//
// 名次边界：SSS 前 3；SS+ 前 10；SS 前 20；SS- 前 30；
// S+ 前 50；S 前 70；S- 前 100；
// A+ 前 150；A 前 200；A- 前 250；B+ 前 350；B 前 450；B- 前 550。
// 第 550 名后的玩家由 C+～F 共 10 档按等比 ×1.25 递增瓜分（C+ 最少、F 最多）：
// 各档占剩余池比例 C+ 3.0% / C 3.8% / C- 4.7% / D+ 5.9% / D 7.3% / D- 9.2%
// / E+ 11.5% / E 14.3% / E- 17.9% / F 22.4%。每列 distribution 按此顺序存 23 个阈值。

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

export const RADAR_FIXED_RANKS = [3, 10, 20, 30, 50, 70, 100, 150, 200, 250, 350, 450, 550];
export const RADAR_REMAINING_GRADES = 10;

// C+～F 十档等比递增权重（2026-11-09 张老师定 ×1.25）：1.25 与其幂在二进制浮点下精确，
// 累计占比无误差累积。C+ 权重 1，F 权重 1.25^9 ≈ 7.45。
const REMAINING_RATIO = 1.25;
const REMAINING_WEIGHTS = Array.from(
  { length: RADAR_REMAINING_GRADES },
  (_, i) => REMAINING_RATIO ** i,
);
const REMAINING_WEIGHT_SUM = REMAINING_WEIGHTS.reduce((a, b) => a + b, 0);

/**
 * 由该维度有成绩人数生成 23 档的名次下界（1 基，含末位）。
 * 例：A+ 取第 150 名成绩；C+ 取第 550 + floor((N-550)×3.0%) 名成绩。
 * 不足 550 人时后续边界钳到 N，重复阈值对应空档，判级仍稳定落在可达到的最高档。
 */
export function radarDistributionRanks(total) {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`无效成绩人数: ${total}`);
  const ranks = RADAR_FIXED_RANKS.map((rank) => Math.min(rank, total));
  const base = Math.min(RADAR_FIXED_RANKS[RADAR_FIXED_RANKS.length - 1], total);
  let cum = 0;
  for (let i = 0; i < RADAR_REMAINING_GRADES; i++) {
    cum += REMAINING_WEIGHTS[i];
    ranks.push(total <= base ? total : base + Math.floor(((total - base) * cum) / REMAINING_WEIGHT_SUM));
  }
  ranks[ranks.length - 1] = total;
  return ranks;
}

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
