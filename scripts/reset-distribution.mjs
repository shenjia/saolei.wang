// 重算 distribution（历史军衔阈值 + 个人主页实力图 23 档评级阈值）并插入新行。
//
// 实力图（2026-11-08 张老师定）：SSS 前10 / SS+ 前20 / SS 前30 / SS- 前40 /
// S+ 前60 / S 前80 / S- 前100；第100名后均分 A+～F 共16档。名次与比例算法由
// src/lib/radar-standard.mjs 统一提供，页面判级与评级标准页共用同一顺序。
//
// 旧 title 列仍按 2013 版 Distribution.php 重算，仅作历史参考；现行军衔不读它。
//
// 用法：
//   env -u NODE_OPTIONS node scripts/reset-distribution.mjs          # 只预览，不写库
//   env -u NODE_OPTIONS node scripts/reset-distribution.mjs --apply  # 插入新快照
// 生产 crontab 每天 00:30 带 --apply 执行。radar.ts 分布缓存 TTL 5 分钟，无需重启站点。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RADAR_GRADES, radarDistributionRanks } from "../src/lib/radar-standard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// .env 手动加载（PrismaClient 运行时读 process.env.DATABASE_URL）
for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

// ---------- 配置（移植 TitleConfig / GradeConfig / RankingConfig） ----------
const LEVELS = ["beg", "int", "exp", "sum"]; // RankingConfig::$levels
const ORDERS = ["time", "3bvs"]; // RankingConfig::$orders
const ORDER_ASC = { time: "asc", "3bvs": "desc" }; // UserScores::$order_direct（好的成绩在前）

const TITLES = [
  "大元帅", "元帅", "大将", "上将", "中将", "少将",
  "大校", "上校", "中校", "少校", "上尉", "中尉", "少尉",
  "上士", "中士", "下士", "上等兵", "列兵",
];
const FIXED_TITLES = new Set(["大元帅", "元帅", "大将", "上将", "中将", "少将"]);
const TITLE_DISTRIBUTION = {
  大元帅: 1, 元帅: 10, 大将: 30, 上将: 60, 中将: 100, 少将: 150,
  大校: 0.03, 上校: 0.07, 中校: 0.12, 少校: 0.18, 上尉: 0.25, 中尉: 0.33,
  少尉: 0.42, 上士: 0.52, 中士: 0.63, 下士: 0.75, 上等兵: 0.88, 列兵: 1.0,
};

// Prisma 字段名（camelCase）映射
const FIELD = {
  beg_time: "begTime", beg_3bvs: "beg3bvs",
  int_time: "intTime", int_3bvs: "int3bvs",
  exp_time: "expTime", exp_3bvs: "exp3bvs",
  sum_time: "sumTime", sum_3bvs: "sum3bvs",
};

/** UserScores::getDistributionScore —— 取 field>0 排序后第 offset 名的成绩 */
async function getDistributionScore(level, order, offset, direct = null) {
  const f = FIELD[`${level}_${order}`];
  const row = await prisma.userScores.findFirst({
    where: { [f]: { gt: 0 } },
    select: { [f]: true },
    orderBy: { [f]: direct ?? ORDER_ASC[order] },
    skip: offset,
  });
  const v = row?.[f];
  if (v == null) throw new Error(`offset ${offset} 超出 ${level}_${order} 的数据范围`);
  return v;
}

/** UserScores::count —— field>0 的行数 */
async function countScores(level, order) {
  const f = FIELD[`${level}_${order}`];
  return prisma.userScores.count({ where: { [f]: { gt: 0 } } });
}

/** Distribution::generateTitleDistribution */
async function generateTitleDistribution() {
  const total = await countScores("sum", "time");
  let fixed = 0; // PHP 里 $fixed 跨循环保留
  const out = [];
  for (const t of TITLES) {
    if (FIXED_TITLES.has(t)) {
      fixed = TITLE_DISTRIBUTION[t] - 1;
      out.push(await getDistributionScore("sum", "time", fixed));
    } else if (t === TITLES[TITLES.length - 1]) {
      // order_direction[time]=0（falsy）→ 'desc'：最差成绩
      out.push(await getDistributionScore("sum", "time", 0, "desc"));
    } else {
      const offset = fixed + Math.trunc((total - fixed) * TITLE_DISTRIBUTION[t]);
      out.push(await getDistributionScore("sum", "time", offset));
    }
  }
  return { total, thresholds: out };
}

/** 个人主页实力图 23 档：直接取各档最后一名的成绩（rank 为 1 基，Prisma skip 为 0 基）。 */
async function generateGradeDistribution(level, order) {
  const total = await countScores(level, order);
  const ranks = radarDistributionRanks(total);
  const out = [];
  for (const rank of ranks) out.push(await getDistributionScore(level, order, rank - 1));
  return { total, ranks, thresholds: out };
}

// ---------- 主流程 ----------
const title = await generateTitleDistribution();
console.log(`\n排行总人数（sum_time>0）: ${title.total}`);
console.log("\n军衔阈值（SUM 秒）:");
  TITLES.forEach((t, i) => console.log(`  ${t.padEnd(4, "　")} ≤ ${(title.thresholds[i] / 1000).toFixed(2)}`));

// 预览新阈值下各军衔人数（与 getTitleCounts 同口径）
console.log("\n新阈值下各军衔人数:");
for (let i = 0; i < TITLES.length; i++) {
  const lower = i > 0 ? title.thresholds[i - 1] : undefined;
  const upper = title.thresholds[i];
  const n = await prisma.userScores.count({
    where: { sumTime: { gt: lower ?? 0, lte: upper } },
  });
  console.log(`  ${TITLES[i].padEnd(4, "　")} ${n} 人`);
}

const data = { title: title.thresholds.join(",") };
for (const level of LEVELS) {
  for (const order of ORDERS) {
    const grade = await generateGradeDistribution(level, order);
    data[`${level}${order === "time" ? "Time" : "3bvs"}`] = grade.thresholds.join(",");
    console.log(`\n${level}_${order}（N=${grade.total}，23 档名次边界）:`);
    RADAR_GRADES.forEach((g, i) => {
      const value = (grade.thresholds[i] / 1000).toFixed(3);
      console.log(`  ${g.padEnd(3, " ")}  rank=${String(grade.ranks[i]).padStart(5, " ")}  threshold=${value}`);
    });
  }
}

if (!process.argv.includes("--apply")) {
  console.log("\n预览完成，未写库。确认后加 --apply 插入新 distribution 快照。");
} else {
  const row = await prisma.distribution.create({
    data: {
      size: BigInt(title.total),
      createTime: BigInt(Math.floor(Date.now() / 1000)),
      ...data,
    },
  });
  console.log(`\n已插入新 distribution 行 id=${row.id}（create_time=${row.createTime}，每列 23 档）`);
  console.log("radar.ts 分布缓存 TTL 5 分钟，无需重启站点。");
}

await prisma.$disconnect();
