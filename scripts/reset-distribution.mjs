// 重算 distribution（军衔阈值 + 各级别评级阈值）并插入新行
// 忠实移植 2013 版 protected/logic/Distribution.php::init()（含原版偏移量 quirks）：
//   军衔固定编制（大元帅1/元帅10/大将30/上将60/中将100/少将150，累计值）
//     → 阈值 = sum_time 升序第 (编制-1) 名（0 基 offset）
//   军衔比例编制（大校 3% … 上等兵 88%）
//     → offset = 149 + intval((total-149)*rate)，149 为最后一个固定编制的 offset
//   列兵（最后一档）→ 最差成绩（sum_time 降序第 0 名）
//   评级固定档 SSS/SS/S → offset 直接取 1/7/21（注意原版不 -1，与军衔不同）
//   评级比例档 A..E → offset = 21 + intval((total-21)*rate)
//   F（最后一档）→ 最差成绩（time 降序 / 3bvs 升序，第 0 名）
// 用法：env -u NODE_OPTIONS node scripts/reset-distribution.mjs
// 注意：assess.ts 对 distribution 有模块级缓存，插行后需重启 dev server 生效：
//   launchctl kickstart -k gui/$(id -u)/com.saolei.dev

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const GRADES = ["SSS", "SS", "S", "A", "B", "C", "D", "E", "F"];
const FIXED_GRADES = new Set(["SSS", "SS", "S"]);
const GRADE_DISTRIBUTION = {
  SSS: 1, SS: 7, S: 21,
  A: 0.05, B: 0.14, C: 0.28, D: 0.51, E: 0.89, F: 1.0,
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

/** Distribution::generateGradeDistribution */
async function generateGradeDistribution(level, order) {
  const total = await countScores(level, order);
  let fixed = 0;
  const out = [];
  for (const g of GRADES) {
    if (FIXED_GRADES.has(g)) {
      fixed = GRADE_DISTRIBUTION[g]; // 注意：原版评级不 -1
      out.push(await getDistributionScore(level, order, fixed));
    } else if (g === GRADES[GRADES.length - 1]) {
      // order_direction[order] ? 'asc' : 'desc' —— 最差成绩
      const direct = order === "3bvs" ? "asc" : "desc";
      out.push(await getDistributionScore(level, order, 0, direct));
    } else {
      const offset = fixed + Math.trunc((total - fixed) * GRADE_DISTRIBUTION[g]);
      out.push(await getDistributionScore(level, order, offset));
    }
  }
  return out;
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
    data[`${level === "sum" ? "sum" : level}${order === "time" ? "Time" : "3bvs"}`] =
      (await generateGradeDistribution(level, order)).join(",");
  }
}

const row = await prisma.distribution.create({
  data: {
    size: BigInt(title.total),
    createTime: BigInt(Math.floor(Date.now() / 1000)),
    ...data,
  },
});
console.log(`\n已插入新 distribution 行 id=${row.id}（create_time=${row.createTime}）`);
console.log("提醒：重启 dev server 使模块级缓存失效：launchctl kickstart -k gui/$(id -u)/com.saolei.dev");

await prisma.$disconnect();
