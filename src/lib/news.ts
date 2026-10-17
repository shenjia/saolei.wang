// 动态发布公共入口（2026-09-24）
// 各业务触发点（注册/上传审核/换头像/发帖/评论）统一走这里。
// 2026-10-17 称号快照制：写「发布时刻高级成绩 exp_time + 是否在榜 ranked」，前端渲染时换算称号；
//   - expTimeOverride：破纪录动态传覆盖前旧值 / 入伍·晋升传更新后新值（口径固化在写入点）
//   - 不传时缺省取 user_scores.exp_time 当前值（评论/发帖/回帖/头像等常规动态）
//   - 原 user_score（sum_time 快照，2013 军衔制遗留）已删除

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { userTitleSnapshot } from "./queries";

type Tx = Prisma.TransactionClient;

export async function publishNews(opts: {
  type: number;
  userId: number;
  reference?: number;
  details?: Record<string, unknown>;
  /** 覆盖快照 exp_time（破纪录=旧值 / 入伍·晋升=新值）；缺省取当前值 */
  expTimeOverride?: number;
  /** 缺省当前时间（秒） */
  createTime?: number;
  /** 传入事务 client 时随业务事务一并提交 */
  tx?: Tx;
}): Promise<void> {
  const db = opts.tx ?? prisma;
  const snap = await userTitleSnapshot(opts.userId, db, opts.expTimeOverride);
  await db.news.create({
    data: {
      type: opts.type,
      user: BigInt(opts.userId),
      expTime: BigInt(snap.expTime),
      ranked: snap.ranked ? 1n : 0n,
      reference: BigInt(opts.reference ?? 0),
      detailsData: JSON.stringify(opts.details ?? {}),
      createTime: BigInt(opts.createTime ?? Math.floor(Date.now() / 1000)),
    },
  });
}
