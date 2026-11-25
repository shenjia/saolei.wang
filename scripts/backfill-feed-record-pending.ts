// 首页发现流「待审纪录盘保位」预标记回填（2026-11-25 张老师定）
//
// 背景：首页发现流的纪录盘保位判据是 user_scores(_nf) 的 12 个 *_video 指针，
// 而这些指针只在审核通过时写入——待审时即便已破个人纪录也会占 (用户,级别)
// 3 盘配额。上传链路已改为落 record_pending=1；本脚本补齐存量待审盘。
//
// 口径：与上传链路完全同源（checkFeedRecordEligible = review.ts:userScoresOnInsert
// 的 time/3bvs 比较），只回填「按当前个人纪录此刻判定仍会刷新指针」的待审盘；
// 比历史瞬时纪录更保守，避免把早已不是纪录盘的旧待审盘永久保位。
//
// 用法：
//   env -u NODE_OPTIONS npx tsx scripts/backfill-feed-record-pending.ts          # dry-run
//   env -u NODE_OPTIONS npx tsx scripts/backfill-feed-record-pending.ts --apply  # 落库
import { prisma } from "../src/lib/db";
import { checkFeedRecordEligible } from "../src/lib/record-exempt";
import { VIDEO_STATUS, type VideoLevel } from "../src/lib/config";

type PendingRow = {
  id: bigint;
  user: bigint;
  level: string;
  noflag: boolean;
  board3bv: number;
  realTime: number;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const t0 = Date.now();
  const rows = await prisma.$queryRaw<PendingRow[]>`
    SELECT v.id, v.\`user\`, v.level, vi.noflag, vi.board_3bv AS board3bv, vi.real_time AS realTime
    FROM video v
    JOIN video_info vi ON vi.id = v.id
    WHERE v.status = ${VIDEO_STATUS.NORMAL}
      AND v.record_pending = 0
      AND vi.no_record = 0
    ORDER BY v.create_time DESC
  `;
  console.log(`待审未标记录像：${rows.length} 条（含非运气盘），耗时 ${Date.now() - t0}ms`);

  const hits: bigint[] = [];
  const t1 = Date.now();
  for (const r of rows) {
    const eligible = await checkFeedRecordEligible(
      Number(r.user),
      r.level as VideoLevel,
      r.noflag,
      Number(r.board3bv),
      Number(r.realTime)
    );
    if (eligible) hits.push(r.id);
  }
  console.log(`命中「当前个人纪录」：${hits.length} 条，判定耗时 ${Date.now() - t1}ms`);
  console.log(`命中 id 前 30：${hits.slice(0, 30).map(String).join(", ") || "(无)"}`);

  if (!apply) {
    console.log("dry-run 结束（未写库）；确认无误后加 --apply 落库。");
  } else {
    const t2 = Date.now();
    let done = 0;
    for (const id of hits) {
      await prisma.video.update({ where: { id }, data: { recordPending: 1 } });
      done++;
    }
    console.log(`已落库 ${done} 条，耗时 ${Date.now() - t2}ms`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
