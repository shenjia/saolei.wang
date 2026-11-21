// 低限界 3BVS 伪纪录动态清理后的链对齐脚本（2026-11-21）
//
// 背景：2026-11-01 上线的 syncRecordNewsChain 重放数据源只查 video_scores 单表，
// 老站迁移的 24698 行「3BV<10 但 score_3bvs>0」脏行（10-16 限界收紧时清零未覆盖
// 存量）被当合法纪录点，把「初级3BVS纪录」伪动态补发回 news（含 2022 老时间戳）。
// 2026-11-21 已执行：①video_scores_beg(_nf) 低限界正值清零 ②删除全部 2319 条
// 低限界伪动态。但仍有两类残留需要本脚本对齐：
//   A. or 链断裂：链上真点的 or 指向已删伪点的 cr；
//   B. 缺失真点：用户先有伪纪录（伪 3bvs 很高），后来打了真纪录但 3bvs 低于伪值
//      当时没发动态——伪点删除后这条真纪录动态缺失，需要补发。
// 口径与 src/lib/review.ts syncRecordNewsChain 严格一致（含 2026-11-21 限界过滤）：
// 按 (create_time,id) 重放该玩家该级别 3bvs 链，与 news 现存行 diff（删伪/补缺/修 or）。
// 只处理 od=3bvs 的行（time 链不受本次治理影响）。
//
// 用法: env -u NODE_OPTIONS node --experimental-transform-types \
//         --import ./scripts/sync/ts-extension-loader.mjs scripts/fix-3bvs-news-chain.ts \
//         [--apply]   默认 dry-run；只统计不改库
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { MIN_3BV_FOR_3BVS, NEWS_TYPE, type VideoLevel } from "../src/lib/config";

const apply = process.argv.includes("--apply");
if (!apply) console.log("== dry-run（--apply 才写库）==");

const LEVELS: VideoLevel[] = ["beg", "int", "exp"];

/** 受影响用户 = 名下有 od=3bvs 纪录动态的用户（伪点删除动作已执行，这些用户的链需要核对） */
const users = await prisma.$queryRaw<{ user: bigint }[]>`
  SELECT DISTINCT n.user FROM news n
  WHERE n.type = ${NEWS_TYPE.PERSON_RECORD}
    AND (n.details_data LIKE '%"od":"3bvs"%' OR n.details_data LIKE '%"od": "3bvs"%')
`;
console.log(`受影响用户 ${users.length} 人`);

let delCount = 0;
let insCount = 0;
let orFixCount = 0;

for (const { user: u } of users) {
  const userId = Number(u);
  for (const level of LEVELS) {
    // ① 重放数据源：video_scores 该玩家该级别 + video_info.board_3bv 限界判定
    // （与 review.ts 2026-11-21 版本同款；注意 video_scores 行已清零低限界值，
    //  score_3bvs=0 天然排除，b3 限界双保险）
    const rows = await prisma.$queryRaw<{ id: bigint; b: number; b3: number; ct: bigint }[]>`
      SELECT vs.id, vs.score_3bvs b, vi.board_3bv b3, vs.create_time ct
      FROM video_scores_${Prisma.raw(level)} vs
      JOIN video_info vi ON vi.id = vs.id
      WHERE vs.user = ${BigInt(userId)}
    `;
    const evs = rows
      .map((r) => ({ id: Number(r.id), b: Number(r.b), b3: Number(r.b3), ct: Number(r.ct) }))
      .sort((a, b) => a.ct - b.ct || a.id - b.id);
    const desired = new Map<number, { or: number; cr: number; ct: number }>();
    let prev = 0;
    for (const e of evs) {
      if (e.b > 0 && e.b3 >= MIN_3BV_FOR_3BVS[level] && e.b > prev) {
        desired.set(e.id, { or: prev, cr: e.b, ct: e.ct });
        prev = e.b;
      }
    }
    // ② 现存该玩家该级别 od=3bvs 动态
    const newsRows = await prisma.news.findMany({
      where: { user: u, type: NEWS_TYPE.PERSON_RECORD },
      select: { id: true, reference: true, detailsData: true, expTime: true, ranked: true },
    });
    const mine = newsRows
      .map((r) => {
        let det: { lv?: string; od?: string; or?: unknown; cr?: unknown; nf?: unknown } = {};
        try { det = JSON.parse(r.detailsData); } catch { /* 脏行按空处理 */ }
        return { id: Number(r.id), ref: Number(r.reference), det, expTime: r.expTime, ranked: r.ranked };
      })
      .filter((r) => r.det.lv === level && r.det.od === "3bvs" && Number(r.det.nf ?? 0) === 0);
    // ③ 删伪点（不在期望点集——本次治理的残留 or 断链根）
    const delIds = mine.filter((r) => !desired.has(r.ref)).map((r) => BigInt(r.id));
    if (delIds.length) {
      delCount += delIds.length;
      if (apply) await prisma.news.deleteMany({ where: { id: { in: delIds } } });
    }
    // ④ 补缺失点 / 修 or 链
    const uRow = await prisma.user.findUnique({ where: { id: u }, select: { status: true } });
    const ranked = BigInt(uRow?.status === 0 ? 1 : 0);
    for (const [vid, pt] of desired) {
      const ex = mine.find((r) => r.ref === vid);
      if (ex) {
        const exOr = ex.det.or == null ? 0 : Number(ex.det.or);
        const exCr = ex.det.cr == null ? 0 : Number(ex.det.cr);
        if (exOr !== pt.or || exCr !== pt.cr) {
          orFixCount++;
          if (apply)
            await prisma.news.update({
              where: { id: BigInt(ex.id) },
              data: { detailsData: JSON.stringify({ ...ex.det, or: pt.or, cr: pt.cr }) },
            });
        }
      } else {
        insCount++;
        if (apply)
          await prisma.news.create({
            data: {
              type: NEWS_TYPE.PERSON_RECORD,
              user: u,
              expTime: BigInt(0),
              ranked,
              reference: BigInt(vid),
              detailsData: JSON.stringify({ lv: level, od: "3bvs", or: pt.or, cr: pt.cr, nf: 0 }),
              createTime: BigInt(pt.ct),
            },
          });
      }
    }
  }
}

console.log(`\n统计: 删伪点 ${delCount} / 补缺失点 ${insCount} / 修 or 链 ${orFixCount}`);
if (!apply) console.log("[dry-run] 未写库。确认后加 --apply 执行。");
await prisma.$disconnect();
