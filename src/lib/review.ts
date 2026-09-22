// 审核与成绩管线
// 移植 logic/Review.php、logic/VideoScores.php、logic/UserScores.php、models/UserScoresModel.php
//
// 与旧版的两处刻意差异（均按旧代码意图修正，注释保留）：
// 1. UserScores::removeVideo 旧版把「找次优录像」误写成 `$video->id == getHighScore(...)`（对象与整数比较恒假），
//    导致屏蔽最优录像后该级别成绩被直接清零；这里按意图实现为「有次优则顶替，没有才清零」。
// 2. News::publish 的 user_score 旧版用的是审核前加载的（过期）sum_time，这里用成绩更新后的最新值。

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  isManager,
  NEWS_TYPE,
  USER_ROLE,
  VIDEO_STATUS,
  type Order,
  type VideoLevel,
} from "./config";
import { videoScores } from "./queries";

type Tx = Prisma.TransactionClient;

const ORDERS: Order[] = ["time", "3bvs"];

// ---------- 录像成绩表（video_scores_{level}(_nf)，主键=录像 id） ----------

function videoScoresTable(tx: Tx, level: VideoLevel, nf: boolean) {
  const key = `videoScores${level[0].toUpperCase()}${level.slice(1)}${nf ? "Nf" : ""}` as const;
  return (tx as unknown as Record<string, VideoScoresDelegate>)[key];
}

interface VideoScoresDelegate {
  findUnique(args: { where: { id: bigint } }): Promise<unknown>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, string>;
  }): Promise<{ id: bigint } | null>;
  upsert(args: {
    where: { id: bigint };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  deleteMany(args: { where: { id: bigint } }): Promise<unknown>;
}

// user_scores 与 user_scores_nf 结构一致，收敛为统一委托类型（同 queries.ts 的 ScoresDelegate 手法）
interface UserScoresDelegate {
  findUnique(args: { where: { id: bigint } }): Promise<unknown>;
  upsert(args: {
    where: { id: bigint };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  update(args: { where: { id: bigint }; data: Record<string, unknown> }): Promise<unknown>;
}

function userScoresTable(tx: Tx, nf: boolean): UserScoresDelegate {
  return (nf ? tx.userScoresNf : tx.userScores) as unknown as UserScoresDelegate;
}

/** 录像成绩：time=real_time(ms)，3bvs=board_3bv×1e6/real_time（3BV<4 记负，入 video_scores 时取 max(0)） */
interface ReviewVideo {
  id: number;
  level: VideoLevel;
  user: number;
  createTime: number;
  reviewTime: number | null;
  noflag: boolean;
  board3bv: number;
  realTime: number;
}

/** VideoScores::update —— 把录像写入对应级别成绩表 */
async function upsertVideoScores(tx: Tx, v: ReviewVideo, nf: boolean) {
  const s = videoScores(v.board3bv, v.realTime);
  const table = videoScoresTable(tx, v.level, nf);
  await table.upsert({
    where: { id: BigInt(v.id) },
    create: {
      id: BigInt(v.id),
      user: BigInt(v.user),
      scoreTime: s.time,
      score3bvs: Math.max(s["3bvs"], 0),
      createTime: BigInt(v.createTime),
    },
    update: { scoreTime: s.time, score3bvs: Math.max(s["3bvs"], 0) },
  });
}

/** VideoScores::getHighScore —— 用户在某级别某榜的最优录像 id */
async function getHighScoreVideoId(
  tx: Tx,
  userId: number,
  level: VideoLevel,
  order: Order,
  nf: boolean
): Promise<number | null> {
  const table = videoScoresTable(tx, level, nf);
  const row = await table.findFirst({
    where: {
      user: BigInt(userId),
      ...(order === "time" ? { scoreTime: { gt: 0 } } : { score3bvs: { gt: 0 } }),
    },
    orderBy: order === "time" ? { scoreTime: "asc" } : { score3bvs: "desc" },
  });
  return row ? Number(row.id) : null;
}

// ---------- 用户成绩（user_scores(_nf)，主键=用户 id） ----------

type UserScoresRow = Record<string, bigint | number | null> & { id: bigint };

const F = (level: string, order: Order, suffix: "" | "Video" | "Date" = "") =>
  `${level}${order === "time" ? "Time" : "3bvs"}${suffix}`;

/** updateSumScores：三级都有成绩才算总计，否则总计清零 */
function withSum(row: Record<string, number | null>): void {
  const t = ["beg", "int", "exp"].map((l) => row[F(l, "time")] ?? 0);
  const b = ["beg", "int", "exp"].map((l) => row[F(l, "3bvs")] ?? 0);
  row.sumTime = t.every((x) => x > 0) ? t.reduce((a, c) => a + c, 0) : 0;
  row.sum3bvs = b.every((x) => x > 0) ? b.reduce((a, c) => a + c, 0) : 0;
}

function rowToNumbers(row: UserScoresRow | null): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      if (k === "id") continue;
      out[k] = v == null ? null : Number(v);
    }
  }
  return out;
}

/** UserScores::insertVideo —— 录像通过审核后更新用户最好成绩，返回更新前后成绩（供发动态） */
async function userScoresOnInsert(
  tx: Tx,
  v: ReviewVideo,
  nf: boolean
): Promise<{ original: Record<string, number | null>; updated: Record<string, number | null> }> {
  const table = userScoresTable(tx, nf);
  const existing = (await table.findUnique({ where: { id: BigInt(v.user) } })) as UserScoresRow | null;
  const original = rowToNumbers(existing);
  const merged = { ...original };
  const s = videoScores(v.board3bv, v.realTime);

  // updateScore：时间更小 / 3BV/s 更大才更新（移植 insertVideo 的比较逻辑）
  const curTime = merged[F(v.level, "time")] ?? 0;
  if (curTime === 0 || s.time < curTime) {
    merged[F(v.level, "time")] = s.time;
    merged[F(v.level, "time", "Video")] = v.id;
    merged[F(v.level, "time", "Date")] = v.createTime;
  }
  const cur3bvs = merged[F(v.level, "3bvs")] ?? 0;
  if ((cur3bvs === 0 || s["3bvs"] > cur3bvs) && s["3bvs"] > 0) {
    merged[F(v.level, "3bvs")] = s["3bvs"];
    merged[F(v.level, "3bvs", "Video")] = v.id;
    merged[F(v.level, "3bvs", "Date")] = v.createTime;
  }
  withSum(merged);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const data = Object.fromEntries(
    Object.entries(merged).map(([k, val]) => [
      k,
      val == null ? null : k.endsWith("Video") || k.endsWith("Date") ? BigInt(val) : val,
    ])
  );
  await table.upsert({
    where: { id: BigInt(v.user) },
    create: { id: BigInt(v.user), ...data, createTime: now, updateTime: now },
    update: { ...data, updateTime: now },
  });
  return { original, updated: merged };
}

/** UserScores::removeVideo —— 录像被屏蔽后，若它是用户最优成绩则用次优顶替，否则清零 */
async function userScoresOnRemove(tx: Tx, v: ReviewVideo, nf: boolean): Promise<void> {
  const table = userScoresTable(tx, nf);
  const existing = (await table.findUnique({ where: { id: BigInt(v.user) } })) as UserScoresRow | null;
  if (!existing) return;
  const merged = rowToNumbers(existing);

  for (const order of ORDERS) {
    if (Number(existing[F(v.level, order, "Video")] ?? 0) !== v.id) continue;
    const nextId = await getHighScoreVideoId(tx, v.user, v.level, order, nf);
    if (nextId) {
      const nv = await loadReviewVideo(tx, nextId);
      if (nv) {
        const s = videoScores(nv.board3bv, nv.realTime);
        merged[F(v.level, order)] = s[order];
        merged[F(v.level, order, "Video")] = nv.id;
        merged[F(v.level, order, "Date")] = nv.createTime;
        continue;
      }
    }
    // resetScore
    merged[F(v.level, order)] = null;
    merged[F(v.level, order, "Video")] = null;
    merged[F(v.level, order, "Date")] = null;
  }
  withSum(merged);

  await table.update({
    where: { id: BigInt(v.user) },
    data: {
      ...Object.fromEntries(
        Object.entries(merged).map(([k, val]) => [
          k,
          val == null ? null : k.endsWith("Video") || k.endsWith("Date") ? BigInt(val) : val,
        ])
      ),
      updateTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
}

// ---------- 动态 ----------

/** News::publish（user_score 取成绩更新后的 sum_time，见文件头说明 2） */
async function publishNews(
  tx: Tx,
  type: number,
  userId: number,
  userScore: number,
  reference: number,
  details: Record<string, unknown>,
  createTime?: number
) {
  await tx.news.create({
    data: {
      type,
      user: BigInt(userId),
      userScore,
      reference: BigInt(reference),
      detailsData: JSON.stringify(details),
      createTime: BigInt(createTime ?? Math.floor(Date.now() / 1000)),
    },
  });
}

// ---------- 审核主流程 ----------

async function loadReviewVideo(tx: Tx, id: number): Promise<ReviewVideo | null> {
  const v = await tx.video.findUnique({ where: { id: BigInt(id) } });
  if (!v) return null;
  const info = await tx.videoInfo.findUnique({ where: { id: v.id } });
  if (!info) return null;
  return {
    id: Number(v.id),
    level: v.level as VideoLevel,
    user: Number(v.user),
    createTime: Number(v.createTime),
    reviewTime: v.reviewTime ? Number(v.reviewTime) : null,
    noflag: info.noflag,
    board3bv: info.board3bv,
    realTime: info.realTime,
  };
}

/**
 * Review::video —— 审核录像
 * 校验：管理员权限 / 录像存在 / 必须先下载过（防盲审）/ 状态合法 / 已审过的仅超管可重审
 */
export async function reviewVideo(
  reviewerId: number,
  reviewerRole: number,
  videoId: number,
  status: number
): Promise<{ ok: boolean; error?: string }> {
  if (!isManager(reviewerRole)) return { ok: false, error: "没有审核权限" };
  if (![VIDEO_STATUS.BANNED, VIDEO_STATUS.NORMAL, VIDEO_STATUS.REVIEWED].includes(status as 0 | 10 | 20)) {
    return { ok: false, error: "非法的审核状态" };
  }

  const video = await prisma.video.findUnique({ where: { id: BigInt(videoId) } });
  if (!video) return { ok: false, error: "录像不存在" };
  const stat = await prisma.videoStat.findUnique({ where: { id: video.id } });
  if (!stat || stat.downloads === 0) {
    return { ok: false, error: "请先下载观看该录像后再审核（禁止盲审）" };
  }
  if (video.reviewUser && reviewerRole !== USER_ROLE.ADMINISTRATOR) {
    return { ok: false, error: "该录像已审核过，仅超级管理员可以重审" };
  }

  await prisma.$transaction(async (tx) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await tx.video.update({
      where: { id: BigInt(videoId) },
      data: {
        status,
        reviewUser: BigInt(reviewerId),
        reviewTime: now,
        updateTime: now,
      },
    });

    const rv = await loadReviewVideo(tx, videoId);
    if (!rv) throw new Error("录像数据不完整");
    rv.reviewTime = Number(now);

    if (status === VIDEO_STATUS.BANNED) {
      // VideoScores::removeVideo
      await videoScoresTable(tx, rv.level, false).deleteMany({ where: { id: BigInt(videoId) } });
      await userScoresOnRemove(tx, rv, false);
      if (rv.noflag) {
        await videoScoresTable(tx, rv.level, true).deleteMany({ where: { id: BigInt(videoId) } });
        await userScoresOnRemove(tx, rv, true);
      }
    } else if (status === VIDEO_STATUS.REVIEWED) {
      // VideoScores::insertVideo → flag 榜（含动态），NF 录像同时入 NF 榜（不发动态）
      await upsertVideoScores(tx, rv, false);
      const { original, updated } = await userScoresOnInsert(tx, rv, false);
      if (rv.noflag) {
        await upsertVideoScores(tx, rv, true);
        await userScoresOnInsert(tx, rv, true);
      }

      const sumTime = updated.sumTime ?? 0;
      if ((original.sumTime ?? 0) === 0 && sumTime > 0) {
        // 入伍新兵动态（时间取审核时间）
        await publishNews(tx, NEWS_TYPE.NEWBIE, rv.user, sumTime, 0, {}, rv.reviewTime!);
      } else {
        // 个人纪录动态（时间取录像上传时间）
        for (const level of ["beg", "int", "exp"] as VideoLevel[]) {
          for (const order of ORDERS) {
            if (Number(updated[F(level, order, "Video")] ?? 0) === rv.id) {
              await publishNews(
                tx,
                NEWS_TYPE.PERSON_RECORD,
                rv.user,
                sumTime,
                rv.id,
                {
                  lv: level,
                  od: order,
                  or: original[F(level, order)] ?? 0,
                  cr: updated[F(level, order)] ?? 0,
                  nf: 0,
                },
                rv.createTime
              );
            }
          }
        }
      }
    }
  });
  return { ok: true };
}
