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
//
// 2026-11-21 两项口径升级（张老师定，起因 /user/35193 同批多录像只有破纪录那盘显新军衔）：
// ① 流水入池时刻：老站段=create_time、新站段=max(create_time, review_time)——
//   补审录像的成绩按过审时刻进流水，不再「时间旅行」（与 fix-record-ban-snapshots.py
//   inflow_time 同源）；
// ② video 行快照语义从「上传时刻」改为「过审时刻 + 上传序前缀 min 钳制」，
//   收敛到 recheckVideoSnapshotsAlongUpload 单一实现（syncTitleSnapshots 的 video 段
//   与 review.ts 过审分支都走它；存量复核走 scripts/recheck-video-snapshots.py 同口径）。

import { Prisma } from "@prisma/client";
import { NEWS_TYPE } from "./config";

type Tx = Prisma.TransactionClient;

export const NEW_SITE_TS = 1790179200; // 2026-09-24 新站上线时刻（秒），此前=老站同步段

/** 2026-11-21 流水入池时刻口径（与 scripts/fix-record-ban-snapshots.py inflow_time 同源）：
 *  老站同步段（create_time < 新站上线）= create_time（review_time 会被 2026-11 重核/补审
 *  刷新，不可作入池证据）；新站段 = max(create_time, review_time)——过审才入池，
 *  补审录像（review_time 远晚于上传）的成绩按过审时刻进流水，避免「时间旅行流水」。 */
export function inflowTime(ct: number, rt: number | null): number {
  return ct < NEW_SITE_TS ? ct : Math.max(ct, rt ?? 0);
}

/** 高级成绩流水（入池时刻口径）：id/入池时刻 ct/成绩 st，按 (ct, id) 排序 */
export interface ExpFlow {
  id: number;
  ct: number;
  st: number;
}

/** 拉取该用户高级成绩流水并按 (入池时刻, id) 排序（被封录像的流水已删，天然排除） */
export async function loadExpFlows(tx: Tx, userId: number): Promise<ExpFlow[]> {
  const rows = await tx.$queryRaw<{ id: bigint; st: number; ct: bigint; rt: bigint | null }[]>`
    SELECT f.id, f.score_time st, f.create_time ct, v.review_time rt
    FROM video_scores_exp f JOIN video v ON v.id = f.id
    WHERE f.user = ${BigInt(userId)} AND f.score_time > 0
  `;
  return rows
    .map((r) => ({
      id: Number(r.id),
      ct: inflowTime(Number(r.ct), r.rt == null ? null : Number(r.rt)),
      st: Number(r.st),
    }))
    .sort((a, b) => a.ct - b.ct || a.id - b.id);
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

/**
 * 2026-11-21 张老师定（起因 /user/35193 同批多录像只有破纪录那盘显新军衔）：
 * video.exp_time 语义从「上传时刻」改为「过审时刻」——每盘录像的快照 = 截至本盘
 * 过审时刻（入池时刻）的高级 running best，同审核周期过审的录像统一显过审时军衔，
 * 与动态体系同口径。
 *
 * 并沿上传序做前缀 min 钳制：正常顺序审下重放值天然单调不增，钳制是恒等变换；
 * 乱序审（快成绩后传先审、慢成绩先传后审）时重放值可能回弹——若不加钳制，后传的
 * 录像会显旧军衔而先传的显新军衔＝「新录像军衔比旧录像还低」，张老师明令禁止。
 * 钳制后语义 = 「传到这盘为止的历史最好高级成绩」（前缀 running best），
 * 数学上保证沿上传序单调不升（毫秒值越小军衔越高）。
 *
 * 调用方：
 * - review.ts 过审分支（增量）：过审事务内调用，本盘成绩刚入 video_scores 流水，
 *   重放自动含它；翻案（屏蔽→通过）重走本分支天然收敛；
 * - syncTitleSnapshots（屏蔽级联）与本函数的 python 孪生 scripts/recheck-video-snapshots.py
 *   （存量复核），三处口径必须同步改（铁律同 3bv-limit-hygiene）。
 *
 * 行期望值：本盘在流水（已过审且 score_time>0）→ 前缀 best（含本盘）；不在流水
 * （待审/运气盘/屏蔽中）→ 本盘上传时刻严格早于的 running best（过审前的行停在
 * 传时军衔，自身流水行因入池时刻≥上传时刻被严格早于天然排除）。
 * 期望=0（从未有过高级成绩）=预备役；ranked 一律不动。
 * 更新带 exp_time=旧值护栏（防并发覆盖），返回修正行数（0=本就一致，幂等）。
 */
export async function recheckVideoSnapshotsAlongUpload(tx: Tx, userId: number): Promise<number> {
  const flows = await loadExpFlows(tx, userId);
  // 前缀 running best：bestAt[i] = 流水前缀（含 i）最好成绩
  let runningBest = 0;
  const bestAt = flows.map((f) => {
    if (runningBest === 0 || f.st < runningBest) runningBest = f.st;
    return runningBest;
  });
  const flowIdxById = new Map(flows.map((f, i) => [f.id, i]));

  // video 行按上传序 (create_time, id) 排列，逐行求期望并做前缀 min 钳制
  const videoRows = await tx.video.findMany({
    where: { user: BigInt(userId) },
    select: { id: true, createTime: true, expTime: true },
  });
  videoRows.sort((a, b) => Number(a.createTime) - Number(b.createTime) || Number(a.id) - Number(b.id));

  let floor = 0; // 前缀 min 钳制地板：上传序前面行已写入的最小毫秒值（军衔只升不降）
  let fixed = 0;
  for (const r of videoRows) {
    const idx = flowIdxById.get(Number(r.id));
    let expect: number;
    if (idx !== undefined) {
      // 已过审且成绩>0：截至本盘入池时刻的前缀 best（同刻过审的多盘按 id 序
      // 逐盘并入，天然满足「后盘不比前盘低」）
      expect = bestAt[idx];
    } else {
      // 待审/运气盘/屏蔽中：本盘上传时刻的前缀 best（严格早于）
      expect = replayExpBest(flows, Number(r.createTime), false);
    }
    // 前缀 min 钳制：不允许比上传序前一行更低（新录像军衔不得低于旧录像）。
    // floor>0 时 expect=0 理论不可达（floor>0 蕴含此前已有正流水），防御性兜住。
    if (floor > 0 && (expect === 0 || expect > floor)) expect = floor;
    if (expect > 0) floor = floor > 0 ? Math.min(floor, expect) : expect;
    if (Number(r.expTime) === expect) continue;
    await tx.video.updateMany({
      where: { id: r.id, expTime: r.expTime },
      data: { expTime: BigInt(expect) },
    });
    fixed++;
  }
  return fixed;
}

/** 行内军衔快照统一重放：屏蔽纪录录像后调用，重放该用户高级 running best。
 *  返回修正行数（0=本就一致，幂等）。video 段走 recheckVideoSnapshotsAlongUpload
 *  （2026-11-21 起 video 快照语义=过审时刻+前缀 min，见其注释）。 */
export async function syncTitleSnapshots(tx: Tx, userId: number): Promise<number> {
  // 基底：该用户高级成绩流水（入池时刻口径，2026-11-21 升级——补审成绩按过审时刻进流水）
  const expFlows = await loadExpFlows(tx, userId);
  const flows = expFlows.map((f) => ({ ct: f.ct, st: f.st }));

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

  // comment / bbs_post / bbs_reply：严格早于
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

  // video：2026-11-21 起语义=过审时刻+上传序前缀 min，收敛到单一实现
  fixed += await recheckVideoSnapshotsAlongUpload(tx, userId);

  return fixed;
}
