// 审核与成绩管线
// 移植 logic/Review.php、logic/VideoScores.php、logic/UserScores.php、models/UserScoresModel.php
//
// 与旧版的两处刻意差异（均按旧代码意图修正，注释保留）：
// 1. UserScores::removeVideo 旧版把「找次优录像」误写成 `$video->id == getHighScore(...)`（对象与整数比较恒假），
//    导致屏蔽最优录像后该级别成绩被直接清零；这里按意图实现为「有次优则顶替，没有才清零」。
// 2. News::publish 的 user_score 旧版用的是审核前加载的（过期）sum_time，这里用成绩更新后的最新值。

import { Prisma } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "./db";
import { ensureVideoMetrics } from "./videometrics";
import {
  isManager,
  LEVEL_MIN_3BV,
  NEWS_TYPE,
  USER_ROLE,
  VIDEO_STATUS,
  type Order,
  type VideoLevel,
} from "./config";
import { videoScores } from "./queries";
import { publishNews } from "./news";
import { sendSystemMessage } from "./message";
import { refreshUserStnb } from "./userstnb";
import { applyRankScoreChange } from "./userrank";
import { LEVEL_NAMES } from "./config";
import { scoreTime } from "./format";

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

/** 录像成绩：time=real_time(ms)，3bvs=board_3bv×1e6/real_time（3BV 低于级别限界记负——2026-10-16 起初级 ≥10 才有效，入 video_scores 时取 max(0)） */
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
  const s = videoScores(v.board3bv, v.realTime, v.level);
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

/** updateSumScores：时间三级都有才合计；3BV/s 允许「有初级成绩但未达 3BV 限界」按 0 参与合计。
 *  完全没有初级成绩时仍是 null，不能误当 0 生成总计（2026-10-26 张老师定）。 */
function withSum(row: Record<string, number | null>): void {
  const hasBeg = (row[F("beg", "time")] ?? 0) > 0;
  if (hasBeg && row[F("beg", "3bvs")] == null) row[F("beg", "3bvs")] = 0;
  if (!hasBeg && row[F("beg", "3bvs")] === 0) row[F("beg", "3bvs")] = null;
  const t = ["beg", "int", "exp"].map((l) => row[F(l, "time")] ?? 0);
  const b = ["beg", "int", "exp"].map((l) => row[F(l, "3bvs")] ?? 0);
  row.sumTime = t.every((x) => x > 0) ? t.reduce((a, c) => a + c, 0) : 0;
  row.sum3bvs = hasBeg && b[1] > 0 && b[2] > 0 ? b.reduce((a, c) => a + c, 0) : 0;
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
  const s = videoScores(v.board3bv, v.realTime, v.level);

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

/** UserScores::removeVideo —— 录像被屏蔽后，若它是用户最优成绩则用次优顶替，否则清零。
 *  返回更新前后成绩（供名次落盘判断 sum_time 变化方向；与 userScoresOnInsert 同款） */
async function userScoresOnRemove(
  tx: Tx,
  v: ReviewVideo,
  nf: boolean
): Promise<{ original: Record<string, number | null>; updated: Record<string, number | null> }> {
  const table = userScoresTable(tx, nf);
  const existing = (await table.findUnique({ where: { id: BigInt(v.user) } })) as UserScoresRow | null;
  if (!existing) return { original: {}, updated: {} };
  const merged = rowToNumbers(existing);

  for (const order of ORDERS) {
    if (Number(existing[F(v.level, order, "Video")] ?? 0) !== v.id) continue;
    const nextId = await getHighScoreVideoId(tx, v.user, v.level, order, nf);
    if (nextId) {
      const nv = await loadReviewVideo(tx, nextId);
      if (nv) {
        const s = videoScores(nv.board3bv, nv.realTime, nv.level);
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
  const original = rowToNumbers(existing);
  return { original, updated: merged };
}

// ---------- 动态（发布走 lib/news.ts 公共入口；user_score 取成绩更新后的 sum_time，见文件头说明 2） ----------

// ---------- 录像计数（user_stat.beg/int/exp_videos） ----------
//
// 2026-10-26 钱1033旭程报障发现：这三列只有同步管线（transform.py 从旧站
// MSSQL IsLive 实时 COUNT）在写，新站审核/上传/删除流程从未维护 →
// 上线后过审的录像全部漏计（生产 189 人偏少、106 封禁号残留偏多）。
// 修复口径（与前台可见性一致）：status<>0 即计数（待审 10 + 通过 20），
// 屏蔽 0 不计——旧站前台也是实时 COUNT(IsLive=1)（含未审），同语义。

/** 按状态是否计入 user_stat 录像计数（待审 10 / 通过 20 计，屏蔽 0 不计） */
function countsVideo(status: number): boolean {
  return status !== VIDEO_STATUS.BANNED;
}

/** 审核状态变迁时同步 user_stat 计数（旧态/新态差值，差 0 不动作）。
 *  upsert：行可能缺失（merge-migration ingest 段只建 user/user_auth 漏建 stat 行） */
async function syncUserStatVideoCount(
  tx: Tx,
  userId: number,
  level: string,
  delta: number
) {
  if (!delta) return;
  const field =
    level === "beg" ? "begVideos" : level === "int" ? "intVideos" : "expVideos";
  const now = BigInt(Math.floor(Date.now() / 1000));
  await tx.userStat.upsert({
    where: { id: BigInt(userId) },
    create: { id: BigInt(userId), [field]: Math.max(delta, 0), createTime: now, updateTime: now },
    update: { [field]: { increment: delta }, updateTime: now },
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
 * 校验：管理员权限 / 录像存在 / 必须先看过（防盲审）/ 状态合法 / 已审过的仅超管可重审
 * 防盲审口径（2026-10-19 扩展）：下载过（downloads>0）或在后台播放器里看过（admin_watched）
 * 都算「看过」；免核定批量通过由 opts.skipWatchCheck 跳过（池内零触发器命中，分拣闸门保证）。
 */
export async function reviewVideo(
  reviewerId: number,
  reviewerRole: number,
  videoId: number,
  status: number,
  opts: { skipWatchCheck?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (!isManager(reviewerRole)) return { ok: false, error: "没有审核权限" };
  if (![VIDEO_STATUS.BANNED, VIDEO_STATUS.NORMAL, VIDEO_STATUS.REVIEWED].includes(status as 0 | 10 | 20)) {
    return { ok: false, error: "非法的审核状态" };
  }

  const video = await prisma.video.findUnique({ where: { id: BigInt(videoId) } });
  if (!video) return { ok: false, error: "录像不存在" };
  if (!opts.skipWatchCheck) {
    const stat = await prisma.videoStat.findUnique({ where: { id: video.id } });
    if (!stat || (stat.downloads === 0 && stat.adminWatched === 0)) {
      return { ok: false, error: "请先下载观看该录像后再审核（禁止盲审）" };
    }
  }
  if (video.reviewUser && reviewerRole !== USER_ROLE.ADMINISTRATOR) {
    return { ok: false, error: "该录像已审核过，仅超级管理员可以重审" };
  }

  // 屏蔽通知要在事务外发（见下方），先把录像关键信息带出来
  // （对象包装避免 TS 闭包赋值收窄为 never）
  const rvOut: { v: { id: number; user: number; level: string; realTime: number } | null } = { v: null };

  await prisma.$transaction(async (tx) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await tx.video.update({
      where: { id: BigInt(videoId) },
      data: {
        status,
        reviewUser: BigInt(reviewerId),
        reviewTime: now,
        updateTime: now,
        // 人工审核动作重置连坐标记（2026-10-16 限时封禁）：防止残留 status_bak 在账号解禁时误恢复
        statusBak: 0,
      },
    });

    // user_stat 录像计数（2026-10-26 补）：按「审核前旧态 → 新态」的计数差调整；
    // 普通待审→通过 +1、通过→屏蔽 -1、屏蔽→通过 +1（重审翻案）、同态差 0 不动作。
    // countsVideo 口径与前台可见性一致（待审/通过计、屏蔽不计）
    const countDelta =
      (countsVideo(status) ? 1 : 0) - (countsVideo(Number(video.status)) ? 1 : 0);
    if (countDelta !== 0) {
      await syncUserStatVideoCount(tx, Number(video.user), video.level, countDelta);
    }

    const rv = await loadReviewVideo(tx, videoId);
    if (!rv) throw new Error("录像数据不完整");
    rv.reviewTime = Number(now);
    rvOut.v = { id: rv.id, user: rv.user, level: rv.level, realTime: rv.realTime };

    if (status === VIDEO_STATUS.BANNED) {
      // VideoScores::removeVideo
      await videoScoresTable(tx, rv.level, false).deleteMany({ where: { id: BigInt(videoId) } });
      const removed = await userScoresOnRemove(tx, rv, false);
      // 名次落盘（2026-10-22 张老师定）：屏蔽撤纪录 → sum_time 变大/掉榜，增量搬位
      await applyRankScoreChange(tx, rv.user, removed.original.sumTime ?? 0, removed.updated.sumTime ?? 0);
      if (rv.noflag) {
        await videoScoresTable(tx, rv.level, true).deleteMany({ where: { id: BigInt(videoId) } });
        await userScoresOnRemove(tx, rv, true);
      }
      // STNB 榜落盘表（2026-10-20）：屏蔽可能撤掉该用户该级最高 STNB → 单组重算
      await refreshUserStnb(rv.user, rv.level, tx);
      // 屏蔽级联（2026-10-22 张老师定）：录像下线时，其评论与引用它的动态一并删除——
      // 详情页不再有挂空评论/「XX破纪录」动态指向屏蔽录像的问题（video.delete 已同款）
      await tx.comment.deleteMany({ where: { video: BigInt(videoId) } });
      await tx.news.deleteMany({
        where: {
          reference: BigInt(videoId),
          type: {
            in: [
              NEWS_TYPE.PERSON_RECORD,
              NEWS_TYPE.AREA_RECORD,
              NEWS_TYPE.NATION_RECORD,
              NEWS_TYPE.VIDEO,
              // 2026-10-22：录像评论动态（kind=video 的 type=52）一并撤下——
              // 评论行已级联删除，动态再挂着就是「评论了一盘录像」挂空链
              NEWS_TYPE.COMMENT,
            ],
          },
        },
      });
    } else if (status === VIDEO_STATUS.REVIEWED) {
      // VideoScores::insertVideo → flag 榜（含动态），NF 录像同时入 NF 榜（不发动态）
      await upsertVideoScores(tx, rv, false);
      const { original, updated } = await userScoresOnInsert(tx, rv, false);
      // 名次落盘（2026-10-22 张老师定）：破纪录 sum_time 变小 / 首次入伍进榜，增量搬位
      await applyRankScoreChange(tx, rv.user, original.sumTime ?? 0, updated.sumTime ?? 0);
      if (rv.noflag) {
        await upsertVideoScores(tx, rv, true);
        await userScoresOnInsert(tx, rv, true);
      }
      // STNB 榜落盘表（2026-10-20）：新过审录像可能破该用户该级最高 STNB → 单组重算
      // （注意：审核时 video_metrics 行可能还没算出来——ensureVideoMetrics 在事务提交后跑，
      //  那里会再刷新一次；此处先刷是兜「已算过行」的重新审核路径）
      await refreshUserStnb(rv.user, rv.level, tx);

      const sumTime = updated.sumTime ?? 0;
      // 个人纪录动态（时间取录像上传时间）——快照取覆盖前旧 exp_time（显示破之前军衔）
      // 2026-10-24 张老师定：入伍与破纪录不再互斥（原 if/else 会让首次入伍吞掉同刻的
      // 各级首纪录动态）——先发纪录动态（首创行 or=0 渲染成「创造了」），最后发入伍动态收尾。
      // 口径演变：最初取 rv.createTime（上传时间）→ 2026-10-19 因「补审积压旧录像时
      // 动态 id 追表尾而时间是旧的，打破 id 序=create_time 序铁律」改取审核时间（b83e20e）
      // → 2026-10-20 张老师再定改回上传时间（一批补审的动态时间不该全挤在过审时刻），
      // 铁律问题改由消费端解决：动态流排序一律 (create_time, id) 倒序，不再依赖 id 序。
      // 成绩时间语义由 details 的 or/cr（毫秒级成绩）保留；入伍动态仍取审核时间。
      for (const level of ["beg", "int", "exp"] as VideoLevel[]) {
        for (const order of ORDERS) {
          if (Number(updated[F(level, order, "Video")] ?? 0) === rv.id) {
            await publishNews({
              tx,
              type: NEWS_TYPE.PERSON_RECORD,
              userId: rv.user,
              expTimeOverride: original.expTime ?? 0,
              reference: rv.id,
              details: {
                lv: level,
                od: order,
                or: original[F(level, order)] ?? 0,
                cr: updated[F(level, order)] ?? 0,
                nf: 0,
              },
              createTime: rv.createTime,
            });
          }
        }
      }

      if ((original.sumTime ?? 0) === 0 && sumTime > 0) {
        // 入伍新兵动态收尾（时间取审核时间）——快照取更新后 exp_time（含同刻：显示入伍时军衔）。
        // 发布顺序在纪录动态之后（2026-10-24 张老师定：先纪录、后入伍）
        await publishNews({
          tx, type: NEWS_TYPE.NEWBIE, userId: rv.user,
          expTimeOverride: updated.expTime ?? 0,
          createTime: rv.reviewTime!,
        });
      }

      // 上传录像动态已停发（2026-10-17 张老师定：录像一上传就刷屏动态流，撤出）。
      // 2026-09-24 曾启用「每盘通过审核的录像都产生 type=30 动态」，现已不再写入；
      // 存量 type=30 行保留（管理后台仍可按类型查询），但动态流一律不展示（NEWS_FEED_EXCLUDED）

      // 3BV 收集区间扩展（2026-10-13 张老师方案）：新通过录像的 board_3bv 突破
      // level_3bv_range 上下限时扩边，只扩不缩（屏蔽不回缩）；
      // INSERT ... ON DUPLICATE KEY UPDATE 幂等——行不存在时顺便播种。
      // 2026-10-14 张老师：下限按现行排行规则钳到 LEVEL_MIN_3BV（初 2 / 中 30 / 高 100），
      // 低于下限的 3BV 不拉低统计区间（新上传已被上传校验拦住，此处防旧数据路径）
      const bv = Math.max(rv.board3bv, LEVEL_MIN_3BV[rv.level as VideoLevel]);
      await tx.$executeRaw`
        INSERT INTO level_3bv_range (level, min_3bv, max_3bv, create_time, update_time)
        VALUES (${rv.level}, ${bv}, ${bv}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE
          min_3bv = LEAST(min_3bv, VALUES(min_3bv)),
          max_3bv = GREATEST(max_3bv, VALUES(max_3bv)),
          update_time = VALUES(update_time)
      `;
    }
  });

  // 屏蔽通知（2026-10-23 张老师需求）：录像被屏蔽后系统消息告知本人，正文带
  // 详情页可点链接（MSG_LINK_RE 语法）。放事务外——通知失败不应把屏蔽操作带崩
  // （成绩回退/级联清理已提交，消息属锦上添花）；文案不带理由（张老师拍板）。
  const rv0 = rvOut.v;
  if (status === VIDEO_STATUS.BANNED && rv0) {
    try {
      const lv = LEVEL_NAMES[rv0.level as keyof typeof LEVEL_NAMES] ?? rv0.level;
      await sendSystemMessage(
        rv0.user,
        `你上传的录像 [url /video/${rv0.id}]#${rv0.id}[/url]（${lv} ${scoreTime(rv0.realTime)} 秒）未通过审核，如有疑问请联系管理员。`
      );
    } catch (e) {
      console.warn("[review] 屏蔽通知发送失败", videoId, e);
    }
  }

  // 录像指标后置补算（2026-10-14 张老师需求：新录像不必等跑批）
  // 必须排在事务提交「之后」—— ensureVideoMetrics 自己开连接读 video/video_info，
  // 在事务内会读到未提交的中间态（而且事务回滚时白写一行）。
  // caveat：上传入口只能拿到 status=10（待审），所以在线路径只有这里能触发；
  //         同步管线（scripts/sync/transform.py）是直接灌表的，越过这里，靠跑批兜。
  if (status === VIDEO_STATUS.REVIEWED) {
    try {
      after(() => ensureVideoMetrics(videoId));
    } catch {
      // 不在请求上下文（脚本/单测直调 reviewVideo）时 after() 不可用，退化为即时异步执行
      void ensureVideoMetrics(videoId);
    }
  }
  return { ok: true };
}
