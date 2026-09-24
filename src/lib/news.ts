// 动态发布公共入口（2026-09-24）
// 各业务触发点（注册/上传审核/换头像/发帖/评论）统一走这里；
// userScore 缺省自动取用户当前 sum_time（军衔列展示用，无成绩=0）。

import { Prisma } from "@prisma/client";
import { prisma } from "./db";

type Tx = Prisma.TransactionClient;

export async function publishNews(opts: {
  type: number;
  userId: number;
  reference?: number;
  details?: Record<string, unknown>;
  /** 缺省自动查 user_scores.sum_time */
  userScore?: number;
  /** 缺省当前时间（秒） */
  createTime?: number;
  /** 传入事务 client 时随业务事务一并提交 */
  tx?: Tx;
}): Promise<void> {
  const db = opts.tx ?? prisma;
  let userScore = opts.userScore;
  if (userScore === undefined) {
    const scores = await db.userScores.findUnique({
      where: { id: BigInt(opts.userId) },
      select: { sumTime: true },
    });
    userScore = scores?.sumTime ?? 0;
  }
  await db.news.create({
    data: {
      type: opts.type,
      user: BigInt(opts.userId),
      userScore,
      reference: BigInt(opts.reference ?? 0),
      detailsData: JSON.stringify(opts.details ?? {}),
      createTime: BigInt(opts.createTime ?? Math.floor(Date.now() / 1000)),
    },
  });
}
