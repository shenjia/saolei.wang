// 行内军衔快照统一重放（2026-11-05，纪录录像屏蔽级联，起因 /user/28321）
//
// 屏蔽级联此前已回退成绩指针（user_scores）、重放纪录动态链（syncRecordNewsChain）、
// 刷新 STNB/排名快照——但 news/comment/bbs_post/bbs_reply/video 行内的军衔快照
// exp_time 残留由已封成绩派生的旧值，渲染端 recordNewsExpTime 的 min(快照,本盘)
// 公式救不了（快照本身指向已封成绩）→「大徽章上士、行内全上尉」错位。
// 修复：以屏蔽后的 video_scores_exp 流水为基底逐行重放 running best 对齐快照，
// 与 scripts/fix-record-ban-snapshots.py 同源口径（存量已由该脚本 --all 清零，
// 本模块接进屏蔽级联保证增量不再产生残留）。
// 口径：news 入伍(10)「含同刻」、其余类型严格早于；只修 exp_time≠期望的行，
// 更新带 exp_time=旧值护栏（防并发覆盖）；ranked 一律不动。
// 独立成模块的原因：不依赖 next/server（jiti 脚本/测试可直接导入）。

import { Prisma } from "@prisma/client";
import { NEWS_TYPE } from "./config";

type Tx = Prisma.TransactionClient;

// video_scores_exp 委托（同 review.ts 的 videoScoresTable 手法，独立模块不复用其私有实现）
function videoScoresExp(tx: Tx) {
  return (tx as unknown as Record<string, VideoScoresDelegate>).videoScoresExp;
}

interface VideoScoresDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }): Promise<{ scoreTime: number; createTime: bigint }[]>;
}

/** 重放高级成绩流水在 ct 时刻的 running best（inclusive=含同刻，入伍动态口径） */
export function replayExpBest(
  flows: { ct: number; st: number }[],
  ct: number,
  inclusive: boolean
): number {
  let best = 0;
  for (const f of flows) {
    if (inclusive ? f.ct > ct : f.ct >= ct) break;
    if (best === 0 || f.st < best) best = f.st;
  }
  return best;
}

interface SnapshotRow {
  id: bigint;
  createTime: bigint;
  expTime: bigint;
}

/** 逐行重放对齐快照，返回修正行数（exp_time=旧值护栏，防并发覆盖） */
async function fixSnapshotRows(
  rows: SnapshotRow[],
  flows: { ct: number; st: number }[],
  apply: (id: bigint, oldVal: bigint, newVal: bigint) => Promise<unknown>
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const expect = replayExpBest(flows, Number(r.createTime), false);
    if (Number(r.expTime) === expect) continue;
    await apply(r.id, r.expTime, BigInt(expect));
    n++;
  }
  return n;
}

/** 行内军衔快照统一重放：屏蔽纪录录像后调用，重放该用户高级 running best。
 *  返回修正行数（0=本就一致，幂等）。 */
export async function syncTitleSnapshots(tx: Tx, userId: number): Promise<number> {
  // 基底：该用户高级成绩流水（被封录像的成绩行已在屏蔽分支删除，天然排除）
  const scoreRows = await videoScoresExp(tx).findMany({
    where: { user: BigInt(userId), scoreTime: { gt: 0 } },
    select: { scoreTime: true, createTime: true },
  });
  const flows = scoreRows
    .map((r) => ({ ct: Number(r.createTime), st: r.scoreTime }))
    .sort((a, b) => a.ct - b.ct || a.st - b.st);

  const uid = BigInt(userId);
  let fixed = 0;

  // news：入伍(10)含同刻，其余类型严格早于
  const newsRows = await tx.news.findMany({
    where: { user: uid },
    select: { id: true, type: true, createTime: true, expTime: true },
  });
  for (const r of newsRows) {
    const expect = replayExpBest(flows, Number(r.createTime), r.type === NEWS_TYPE.NEWBIE);
    if (Number(r.expTime) === expect) continue;
    await tx.news.updateMany({
      where: { id: r.id, expTime: r.expTime },
      data: { expTime: BigInt(expect) },
    });
    fixed++;
  }

  // comment / bbs_post / bbs_reply / video：严格早于
  const commentRows = await tx.comment.findMany({
    where: { user: uid },
    select: { id: true, createTime: true, expTime: true },
  });
  fixed += await fixSnapshotRows(commentRows, flows, (id, o, v) =>
    tx.comment.updateMany({ where: { id, expTime: o }, data: { expTime: v } })
  );
  const postRows = await tx.bbsPost.findMany({
    where: { user: uid },
    select: { id: true, createTime: true, expTime: true },
  });
  fixed += await fixSnapshotRows(postRows, flows, (id, o, v) =>
    tx.bbsPost.updateMany({ where: { id, expTime: o }, data: { expTime: v } })
  );
  const replyRows = await tx.bbsReply.findMany({
    where: { user: uid },
    select: { id: true, createTime: true, expTime: true },
  });
  fixed += await fixSnapshotRows(replyRows, flows, (id, o, v) =>
    tx.bbsReply.updateMany({ where: { id, expTime: o }, data: { expTime: v } })
  );
  const videoRows = await tx.video.findMany({
    where: { user: uid },
    select: { id: true, createTime: true, expTime: true },
  });
  fixed += await fixSnapshotRows(videoRows, flows, (id, o, v) =>
    tx.video.updateMany({ where: { id, expTime: o }, data: { expTime: v } })
  );

  return fixed;
}
