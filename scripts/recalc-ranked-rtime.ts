// 排行录像成绩口径修正（2026-10-30 张老师定：落库成绩 ＝ flop 播放器显示 ＝ 事件流末端毫秒）
// 配套 EVF 头部重写脚本（服务器 /tmp/evf-rewrite.mjs）的库内定点重算：
//   ① video_info.real_time → 事件流末端毫秒（清单给定）
//   ② video_scores_{level}(_nf) 的 score_time / score_3bvs 重算
//   ③ 受影响用户 user_scores(_nf) 聚合重算（best time/3bvs + sum，口径与 lib/review.ts 一致）
// ⚠️ 跑完后仍需手工执行（见尾部输出提示）：
//    video-metrics --ids-file=...（video_metrics 全指标 + 分位 + 排名重排）
//    scripts/sync/rebuild-user-stnb.ts（STNB 榜全量重建）
//    rank 快照 force 重刷（ranksnap.ensureTodaySnapshot）
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/recalc-ranked-rtime.ts \
//   --list=/tmp/ranked-fix.tsv [--apply]
//   清单格式：每行 `id<TAB>tailMs`（dry-run 缺省只打印，--apply 才写库）
import { readFileSync } from "fs";
import { prisma } from "../src/lib/db";
import { MIN_3BV_FOR_3BVS, VIDEO_LEVELS, type VideoLevel } from "../src/lib/config";

const listArg = process.argv.find((a) => a.startsWith("--list="));
const apply = process.argv.includes("--apply");
if (!listArg) {
  console.error("用法: --list=<id<TAB>tailMs 每行> [--apply]");
  process.exit(1);
}
const items = readFileSync(listArg.slice("--list=".length), "utf8").trim().split("\n")
  .map((l) => l.split("\t").map(Number))
  .filter(([id, ms]) => Number.isInteger(id) && Number.isInteger(ms) && ms > 0) as [number, number][];

/* 与 lib/format.ts videoScores 同式：3BV 低于级别限界记负值 */
function calc3bvs(bbbv: number, realTime: number, level: VideoLevel): number {
  const sign = bbbv >= MIN_3BV_FOR_3BVS[level] ? 1 : -1;
  return realTime > 0 ? sign * Math.round((bbbv * 1_000_000) / realTime) : 0;
}

type Row = { id: bigint; level: string; user: bigint; noflag: number; status: number; board_3bv: number; real_time: number; create_time: bigint };
const ids = items.map(([id]) => id);
const rows = await prisma.$queryRawUnsafe<Row[]>(
  `SELECT v.id, v.level, v.user, i.noflag, v.status, i.board_3bv, i.real_time, v.create_time
     FROM video v JOIN video_info i ON i.id = v.id
    WHERE v.id IN (${ids.map(() => "?").join(",")})`,
  ...ids,
);
const rowMap = new Map(rows.map((r) => [Number(r.id), r]));
const tailMap = new Map(items);

if (!apply) console.log("== dry-run（--apply 才写库）==");
const affected = new Set<string>(); // `${user}:${nf}`
for (const [id, tailMs] of items) {
  const r = rowMap.get(id);
  if (!r) { console.log(`跳过 ${id}：video 行不存在`); continue; }
  if (r.real_time === tailMs) { console.log(`跳过 ${id}：real_time 已是 ${tailMs}`); continue; }
  const level = r.level as VideoLevel;
  if (!VIDEO_LEVELS.includes(level)) { console.log(`跳过 ${id}：非法 level ${r.level}`); continue; }
  const nf = r.noflag === 1;
  const b3 = calc3bvs(r.board_3bv, tailMs, level);
  console.log(`${id} ${level}${nf ? "/nf" : ""} status=${r.status} user=${r.user} real_time ${r.real_time} -> ${tailMs}, 3bvs ${Math.max(b3, 0)}`);
  if (!apply) continue;
  /* 聚合源同 review.ts：video_scores_* 表本身就是登记表（屏蔽时行已删），
     nf 归属以表为准而非录像 noflag —— 免疫脏数据错位。两张表都尝试更新，
     行在哪个表就更新哪个（返回行数应恰为 1，双非 0 告警） */
  affected.add(`${r.user}:${r.noflag}`);
  await prisma.$executeRawUnsafe(`UPDATE video_info SET real_time = ? WHERE id = ?`, tailMs, id);
  for (const table of [`video_scores_${level}`, `video_scores_${level}_nf`]) {
    const n = await prisma.$executeRawUnsafe(
      `UPDATE ${table} SET score_time = ?, score_3bvs = ? WHERE id = ?`,
      tailMs, Math.max(b3, 0), id,
    );
    if (n > 1) console.log(`⚠️ ${table} id=${id} 命中 ${n} 行，异常请核查`);
  }
}

if (!apply) {
  console.log("\n后续（apply 后）：video-metrics --ids-file、rebuild-user-stnb、rank 快照 force");
  await prisma.$disconnect();
  process.exit(0);
}

/* ---- 受影响用户聚合重算（口径 = lib/review.ts userScoresOnInsert + withSum）---- */
const F = (level: string, order: "time" | "3bvs", suffix: "" | "Video" | "Date" = "") =>
  `${level}${order === "time" ? "Time" : "3bvs"}${suffix}`;

/* raw SQL 列名（铁律 snake_case）：beg_time / beg_3bvs / beg_time_video / beg_3bvs_date */
const col = (level: string, order: "time" | "3bvs", suffix: "" | "Video" | "Date" = "") =>
  `${level}_${order === "time" ? "time" : "3bvs"}${suffix ? "_" + suffix.toLowerCase() : ""}`;

for (const key of affected) {
  const [userS, nfS] = key.split(":");
  const nf = nfS === "1";
  const table = nf ? "user_scores_nf" : "user_scores";
  /* 聚合源 = video_scores_{level}(_nf) 表（review.ts getHighScoreVideoId 同源），
     非按 video.status/noflag 重导出——两口径在表维护正确时等价，表直读更稳 */
  const merged: Record<string, number | null> = {};
  for (const level of VIDEO_LEVELS) {
    const srows = await prisma.$queryRawUnsafe<{ id: bigint; score_time: number; score_3bvs: number; create_time: bigint }[]>(
      `SELECT id, score_time, score_3bvs, create_time FROM video_scores_${level}${nf ? "_nf" : ""} WHERE user = ?`,
      BigInt(userS),
    );
    for (const s of srows) {
      if (s.score_time > 0 && ((merged[F(level, "time")] ?? 0) === 0 || s.score_time < (merged[F(level, "time")] ?? 0))) {
        merged[F(level, "time")] = s.score_time;
        merged[F(level, "time", "Video")] = Number(s.id);
        merged[F(level, "time", "Date")] = Number(s.create_time);
      }
      if (s.score_3bvs > 0 && s.score_3bvs > (merged[F(level, "3bvs")] ?? 0)) {
        merged[F(level, "3bvs")] = s.score_3bvs;
        merged[F(level, "3bvs", "Video")] = Number(s.id);
        merged[F(level, "3bvs", "Date")] = Number(s.create_time);
      }
    }
  }
  /* withSum：时间三级都有才合计；初级有成绩但未达限界按 0 参与 3bvs 合计 */
  const hasBeg = (merged[F("beg", "time")] ?? 0) > 0;
  if (hasBeg && merged[F("beg", "3bvs")] == null) merged[F("beg", "3bvs")] = 0;
  if (!hasBeg && merged[F("beg", "3bvs")] === 0) merged[F("beg", "3bvs")] = null;
  const ts = ["beg", "int", "exp"].map((l) => merged[F(l, "time")] ?? 0);
  const bs = ["beg", "int", "exp"].map((l) => merged[F(l, "3bvs")] ?? 0);
  merged.sumTime = ts.every((x) => x > 0) ? ts.reduce((a, c) => a + c, 0) : 0;
  merged.sum3bvs = hasBeg && bs[1] > 0 && bs[2] > 0 ? bs.reduce((a, c) => a + c, 0) : 0;

  const data: Record<string, number | null> = {};
  for (const l of VIDEO_LEVELS) for (const o of ["time", "3bvs"] as const) for (const sfx of ["", "Video", "Date"] as const) {
    const k = F(l, o, sfx);
    data[col(l, o, sfx)] = merged[k] ?? null;
  }
  data["sum_time"] = merged.sumTime;
  data["sum_3bvs"] = merged.sum3bvs;
  const fields = Object.keys(data).map((k) => `\`${k}\` = ?`).join(", ");
  const vals = Object.values(data);
  const res = await prisma.$executeRawUnsafe(
    `UPDATE ${table} SET ${fields}, update_time = UNIX_TIMESTAMP() WHERE id = ?`,
    ...vals, BigInt(userS),
  );
  console.log(`user_scores${nf ? "_nf" : ""} user=${userS} 更新 ${res} 行（sum_time=${merged.sumTime}）`);
}

console.log("\n✅ 定点重算完成。后续手工步骤：");
console.log(`  1. env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/video-metrics.ts --ids-file=<ids>`);
console.log(`  2. env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/sync/rebuild-user-stnb.ts`);
console.log(`  3. rank 快照 force 重刷（ensureTodaySnapshot）`);
await prisma.$disconnect();
