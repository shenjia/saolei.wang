// 破纪录豁免上传数量限制（2026-11-17 张老师定：破个人纪录即豁免）
//
// 口径（2026-11-18 张老师定稿）：本盘 time / 3BV/s / STNB 任一项严格优于
// 「本人当前排行纪录」即豁免每周上传数量上限。
//   · 只对比个人：FL / NF 分池的当前排行纪录（与排名局 PB 核查
//     core/src/app/api/online/ranked/pb 同源）——time/3bvs 取 user_scores(_nf)，
//     stnb 取 user_stnb_best(_nf)。全部单行主键查询，零全表扫描。
//   · 全站纪录不做对比（2026-11-18 张老师：不应扫全表，当日移除三段全表
//     MIN/MAX 查询——曾致每次判定三表 JOIN 扫 30 万行、avg 1.2-1.5s）。
//   · 某 BV 的 PB（同图最快）不算纪录，不在判定内。
//   · 查询直连数据库、不读 getRecordCurves 的 24h 缓存（否则拿到最多一天前的旧纪录）。
//
// 只在上传者本周额度已用完时才调用——常规上传零额外开销。判定失败一律按「未破纪录」
// 处理（保守：不因判定链路故障放开额度闸门）。

import { prisma } from "./db";
import { MIN_3BV_FOR_3BVS, type VideoLevel } from "./config";
import { videoScores } from "./format";
import { stnbOf } from "./videoradar";

export type RecordExempt = {
  exempt: boolean;
  /** 破的个人纪录维度（time / 3bvs / stnb） */
  personal: string[];
};

const NO_RECORD: RecordExempt = { exempt: false, personal: [] };

type ScoresDelegate = {
  findUnique(a: {
    where: { id: bigint };
    select: Record<string, boolean>;
  }): Promise<Record<string, number | null> | null>;
};
type StnbDelegate = {
  findUnique(a: {
    where: { user_level: { user: bigint; level: string } };
    select: { stnb: boolean };
  }): Promise<{ stnb: number } | null>;
};

/**
 * 本盘是否破个人当前排行纪录。入参全部来自上传解析后的权威值（bbbv=board_3bv，
 * timeMs=real_time）。noRecord（运气盘）不调用本函数——它本就不进任何纪录链。
 */
export async function checkRecordExempt(
  uid: number,
  level: VideoLevel,
  noflag: boolean,
  bbbv: number,
  timeMs: number
): Promise<RecordExempt> {
  try {
    // 本盘成绩换算（与过审落库同源：videoScores 的 3bvs 为 ×1000 整数、低于限界记负）
    const s = videoScores(bbbv, timeMs, level);
    const time = timeMs > 0 ? timeMs : 0; // 纪录口径 real_time>0（3BV=1 的 0ms 局不进纪录）
    const bvs = s["3bvs"] > 0 ? s["3bvs"] : 0; // 低于限界的负值/0 不是有效纪录
    const stnb = stnbOf(level, bbbv, timeMs); // 纯函数，与跑批/雷达 stnb 同公式
    if (!time && !bvs && !stnb) return NO_RECORD;

    const id = BigInt(uid);
    // ⚠️ Prisma 字段名是 camelCase（begTime / beg3bvs），级别前缀保持小写——
    // core pb 路由靠 Next 编译期处理、本模块经 Node 直跑时大写开头（BegTime）
    // 会直接 ValidationError（本地库实测证实）。
    const personal: string[] = [];

    // 3BV 未达级别限界（初10/中4/高4）的盘成绩划负，不进任何纪录链——
    // 与 user_scores 的 3bvs 记负语义、userstnb.ts 的 MIN_3BV_FOR_3BVS 同口径。
    // noRecord（3BV 低于级别下限）由上传路由在调用前拦掉，这里再挡限界内的运气盘。
    const belowLimit = bbbv < MIN_3BV_FOR_3BVS[level];
    if (belowLimit) return NO_RECORD;

    // 个人当前排行纪录（FL/NF 分池，单行查询）
    const scores = await (prisma[`userScores${noflag ? "Nf" : ""}`] as unknown as ScoresDelegate).findUnique({
      where: { id },
      select: { [`${level}Time`]: true, [`${level}3bvs`]: true },
    });
    const bestTime = scores ? scores[`${level}Time`] : null;
    const bestBvs = scores ? scores[`${level}3bvs`] : null;
    if (time && (bestTime == null || time < Number(bestTime))) personal.push("time");
    if (bvs && (bestBvs == null || bvs > Number(bestBvs))) personal.push("3bvs");

    const stnbBest = await (prisma[`userStnbBest${noflag ? "Nf" : ""}`] as unknown as StnbDelegate).findUnique({
      where: { user_level: { user: id, level } },
      select: { stnb: true },
    });
    if (stnb && (!stnbBest || stnb > stnbBest.stnb)) personal.push("stnb");

    return { exempt: personal.length > 0, personal };
  } catch {
    return NO_RECORD;
  }
}

/**
 * 首页发现流「纪录盘保位」预判定（2026-11-25 张老师定）：
 * 本盘若此刻立即过审，是否会刷新 user_scores(_nf) 的 time / 3bvs 指针。
 *
 * 口径与 review.ts:userScoresOnInsert 严格同源——只比 time / 3bvs，
 * 不含 STNB（纪录盘保位本来就是那 12 个 *_video 指针的逻辑，STNB 无独立指针）；
 * 判定失败一律按「非纪录盘」保守处理，不因查询故障放开保位名额。
 * 运气盘（no_record）由调用方拦掉——过审都不走成绩分支，恒不写指针。
 * 只查询、不写库、不碰 status。
 */
export async function checkFeedRecordEligible(
  uid: number,
  level: VideoLevel,
  noflag: boolean,
  bbbv: number,
  timeMs: number
): Promise<boolean> {
  try {
    const s = videoScores(bbbv, timeMs, level);
    const scores = await (prisma[`userScores${noflag ? "Nf" : ""}`] as unknown as ScoresDelegate).findUnique({
      where: { id: BigInt(uid) },
      select: { [`${level}Time`]: true, [`${level}3bvs`]: true },
    });
    const curTime = scores ? Number(scores[`${level}Time`] ?? 0) : 0;
    const cur3bvs = scores ? Number(scores[`${level}3bvs`] ?? 0) : 0;
    // 与 userScoresOnInsert 两处 if 逐字同口径（含 curTime=0 的首次写入语义）
    const timeBetter = curTime === 0 || s.time < curTime;
    const bvsBetter = s["3bvs"] > 0 && (cur3bvs === 0 || s["3bvs"] > cur3bvs);
    return timeBetter || bvsBetter;
  } catch {
    return false;
  }
}
