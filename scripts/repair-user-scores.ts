// user_scores(_nf) 六池对账修复（2026-10-28 首页「今日已收集/创造PB」行验证时发现）：
// 站内存在「video_scores_* 有过审录像成绩、user_scores(_nf) 却为 NULL 或劣于真值」的坏行
// （本地库审计：NULL_有录像 ≈85 池格——NF beg 仅 uid=1，FL beg/int/exp 32/25/27 人；
//   劣于录像真值 5 处；「优于录像」的老站无录像遗产纪录属设计内，保留不动）。
// 后果：结算 /pb 核查按 user_scores 池比对——NULL 池每盘胜局误报「首破纪录」金气泡；
//   劣于真值池该报 PB 时不报。
// 修复口径（与 review.ts userScoresOnInsert/getHighScoreVideoId 完全同源）：
//   · 真值来源 = video_scores_<level>(_nf)（应用同源，含已屏蔽盘——remove 逻辑也不过滤状态）
//   · time 取 MIN(score_time)（>0），并列取 id 小者；3bvs 取 MAX(score_3bvs)（>0），并列取 id 小者
//   · 合并策略：当前值 NULL/0 或**劣于** video 真值 → 覆盖（值+*_video 指针+*_date=该盘 create_time）；
//     当前值**优于** video 真值（老站遗产）→ 保留原值与指针
//   · 三级处理完按 review.ts withSum 规则重算 sum_time/sum_3bvs（含 beg_3bvs 0↔null 归一）
// 用法：
//   env -u NODE_OPTIONS npx tsx scripts/repair-user-scores.ts           # dry-run 只打印
//   env -u NODE_OPTIONS npx tsx scripts/repair-user-scores.ts --apply   # 实际写库
// ⚠️ 生产执行后需复核排行影响（user_scores 变更会影响 rank_snapshot，按需跑 rank-snapshot-refresh）。
import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";
import { MIN_3BV_FOR_3BVS } from "../src/lib/config";

const APPLY = process.argv.includes("--apply");
const N = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

type Agg = { mt: number | null; mb: number | null; tVid: number | null; bVid: number | null };
type Level = "beg" | "int" | "exp";

/** user_scores / user_scores_nf 委托联合的公共面（TS2349 → cast 委托接口，见 MEMORY 铁律）；
 *  两表列结构一致，脚本只按字符串键取值，统一按 Record 视图操作 */
interface ScoresDelegate {
  findMany(): Promise<Array<Record<string, bigint | number | null>>>;
  upsert(args: {
    where: { id: bigint };
    create: Record<string, bigint | number | null>;
    update: Record<string, bigint | number | null>;
  }): Promise<unknown>;
}

const TABLES: Record<string, string> = {
  "beg_nf": "video_scores_beg_nf",
  "int_nf": "video_scores_int_nf",
  "exp_nf": "video_scores_exp_nf",
  "beg": "video_scores_beg",
  "int": "video_scores_int",
  "exp": "video_scores_exp",
};

/** 单表聚合：每 user 的最快时间 / 最高 3BV/s 及其录像 id（并列取 id 小者）。
 *  ⚠️ 3BV/s 候选必须限 board_3bv ≥ MIN_3BV_FOR_3BVS（与 format.ts videoScores +
 *  userScoresOnInsert 的 s.3bvs>0 语义同源）：迁移数据里低于限界盘的 score_3bvs
 *  是正数（本地实测 video_scores_beg 24644 行未钳 0），直接 MAX 会把「小盘虚高
 *  3BV/s」当真值写进 user_scores。时间维度无限界，全部盘参与 */
async function aggTable(table: string, bvsLimit: number): Promise<Map<number, Agg>> {
  const rows = await prisma.$queryRaw<{ uid: bigint; mt: number | null; mb: number | null; tvid: bigint | null; bvid: bigint | null }[]>`
    SELECT t.user uid, t.mt, t.mb, t.tvid, t.bvid FROM (
      SELECT vs.\`user\`,
        MIN(NULLIF(vs.score_time, 0)) AS mt,
        MAX(CASE WHEN vi.board_3bv >= ${bvsLimit} THEN NULLIF(vs.score_3bvs, 0) END) AS mb,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN vs.score_time > 0 THEN vs.id END ORDER BY vs.score_time ASC, vs.id ASC SEPARATOR ','), ',', 1) AS tvid,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN vi.board_3bv >= ${bvsLimit} AND vs.score_3bvs > 0 THEN vs.id END ORDER BY CASE WHEN vi.board_3bv >= ${bvsLimit} THEN vs.score_3bvs END DESC, vs.id ASC SEPARATOR ','), ',', 1) AS bvid
      FROM ${Prisma.raw(`\`${table}\``)} vs
      JOIN video_info vi ON vi.id = vs.id
      GROUP BY vs.\`user\`
    ) t`;
  const out = new Map<number, Agg>();
  for (const r of rows) {
    out.set(N(r.uid), {
      mt: r.mt == null ? null : Number(r.mt),
      mb: r.mb == null ? null : Number(r.mb),
      tVid: r.tvid == null ? null : Number(r.tvid),
      bVid: r.bvid == null ? null : Number(r.bvid),
    });
  }
  return out;
}

/** review.ts withSum 同款：时间三级齐全才合计；3BV/s 允许「有初级成绩但未达限界」按 0 参与合计 */
function withSum(row: Record<string, number | null>): void {
  const F = (lv: string, order: "time" | "3bvs") => `${lv}${order === "time" ? "Time" : "3bvs"}`;
  const hasBeg = (row[F("beg", "time")] ?? 0) > 0;
  if (hasBeg && row[F("beg", "3bvs")] == null) row[F("beg", "3bvs")] = 0;
  if (!hasBeg && row[F("beg", "3bvs")] === 0) row[F("beg", "3bvs")] = null;
  const t = ["beg", "int", "exp"].map((l) => row[F(l, "time")] ?? 0);
  const b = ["beg", "int", "exp"].map((l) => row[F(l, "3bvs")] ?? 0);
  row.sumTime = t.every((x) => x > 0) ? t.reduce((a, c) => a + c, 0) : 0;
  row.sum3bvs = hasBeg && b[1] > 0 && b[2] > 0 ? b.reduce((a, c) => a + c, 0) : 0;
}

async function main() {
  console.log(`模式：${APPLY ? "APPLY（写库）" : "dry-run（只打印）"}\n`);
  let changed = 0;
  for (const [key, table] of Object.entries(TABLES)) {
    const nf = key.endsWith("_nf");
    const level = key.replace("_nf", "") as Level;
    const T = (order: "Time" | "3bvs", suffix = "") => `${level}${order}${suffix}`;
    const scores = (nf ? prisma.userScoresNf : prisma.userScores) as unknown as ScoresDelegate;
    const agg = await aggTable(table, MIN_3BV_FOR_3BVS[level]);
    // 该池涉及的全部用户（video_scores 有行的 ∪ user_scores 有行的）
    const scoreRows = await scores.findMany();
    const byId = new Map(scoreRows.map((r) => [N(r.id), r]));
    const users = new Set<number>([...agg.keys(), ...byId.keys()]);
    // 本池涉及的 video create_time（date 字段真值）
    const vidIds = new Set<number>();
    for (const a of agg.values()) {
      if (a.tVid) vidIds.add(a.tVid);
      if (a.bVid) vidIds.add(a.bVid);
    }
    const vidCt = new Map<number, number>();
    if (vidIds.size) {
      const vs = await prisma.video.findMany({
        where: { id: { in: [...vidIds].map((x) => BigInt(x)) } },
        select: { id: true, createTime: true },
      });
      for (const v of vs) vidCt.set(N(v.id), N(v.createTime));
    }

    for (const uid of users) {
      const a = agg.get(uid);
      const row = byId.get(uid);
      const patch: Record<string, number | null> = {};
      const timeV = a?.mt ?? null;
      const bvsV = a?.mb ?? null;
      const curTime = row ? (row[T("Time")] == null ? null : Number(row[T("Time")])) : null;
      const curBvs = row ? (row[T("3bvs")] == null ? null : Number(row[T("3bvs")])) : null;
      // 时间：NULL/0/劣于真值 → 覆盖；优于真值（遗产）→ 保留
      if (timeV != null && (curTime == null || curTime === 0 || curTime > timeV)) {
        patch[T("Time")] = timeV;
        patch[T("Time", "Video")] = a!.tVid;
        patch[T("Time", "Date")] = a!.tVid ? vidCt.get(a!.tVid) ?? null : null;
      }
      // 3BV/s：NULL/0/劣于真值 → 覆盖
      if (bvsV != null && (curBvs == null || curBvs === 0 || curBvs < bvsV)) {
        patch[T("3bvs")] = bvsV;
        patch[T("3bvs", "Video")] = a!.bVid;
        patch[T("3bvs", "Date")] = a!.bVid ? vidCt.get(a!.bVid) ?? null : null;
      }
      if (!Object.keys(patch).length) continue;
      // 合并出完整行重算总计（无行则用 patch 起底）
      const merged: Record<string, number | null> = {};
      if (row) {
        for (const [k, v] of Object.entries(row)) {
          if (k === "id" || k.endsWith("_time") || k === "createTime" || k === "updateTime") continue;
          merged[k] = v == null ? null : Number(v);
        }
      }
      // 裸 SQL 列名 → 字段名（patch 键已是驼峰字段名，直接并入）
      for (const [k, v] of Object.entries(patch)) merged[k] = v;
      withSum(merged);
      const data: Record<string, bigint | number | null> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (v == null) { data[k] = null; continue; }
        data[k] = k.endsWith("Video") || k.endsWith("Date") ? BigInt(v) : v;
      }
      const now = BigInt(Math.floor(Date.now() / 1000));
      console.log(
        `[${key}] uid=${uid}：` +
          (curTime !== (merged[T("Time")] ?? null) ? `time ${curTime ?? "NULL"}→${merged[T("Time")]}` : "time 不变") +
          "，" +
          (curBvs !== (merged[T("3bvs")] ?? null) ? `3bvs ${curBvs ?? "NULL"}→${merged[T("3bvs")]}` : "3bvs 不变") +
          `，sumTime→${merged.sumTime} sum3bvs→${merged.sum3bvs}`
      );
      changed++;
      if (APPLY) {
        await scores.upsert({
          where: { id: BigInt(uid) },
          create: { id: BigInt(uid), ...data, createTime: now, updateTime: now },
          update: { ...data, updateTime: now },
        });
      }
    }
  }
  console.log(`\n共 ${changed} 行需要修复${APPLY ? "，已写库" : "（dry-run 未写库，加 --apply 执行）"}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
