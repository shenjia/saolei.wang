// 破纪录豁免上传数量限制（2026-11-17 张老师定：个人纪录 + 全站纪录都算）
//
// 口径：本盘 time / 3BV/s / STNB 任一项严格优于「本人当前最好」或「全站当前纪录」
// 即豁免每周上传数量上限。
//   · 个人纪录：FL / NF 分池（与排名局 PB 核查 core/src/app/api/online/ranked/pb 同源）——
//     time/3bvs 取 user_scores(_nf)，stnb 取 user_stnb_best(_nf)。
//   · 全站纪录：三级三图不区分 FL/NF（与 /records 纪录演变页 records.ts 同源）——
//     time/3bvs 走 video_info，stnb 走 video_metrics，status=20 + no_record=0 +
//     3BV 限界（初10/中4/高4）。
//   · 查询直连数据库、不读 getRecordCurves 的 24h 缓存（否则拿到最多一天前的旧纪录）。
//
// 只在上传者本周额度已用完时才调用——常规上传零额外开销。判定失败一律按「未破纪录」
// 处理（保守：不因判定链路故障放开额度闸门）。

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { MIN_3BV_FOR_3BVS, VIDEO_STATUS, type VideoLevel } from "./config";
import { videoScores } from "./format";
import { stnbOf } from "./videoradar";

export type RecordExempt = {
  exempt: boolean;
  /** 破的个人纪录维度（time / 3bvs / stnb） */
  personal: string[];
  /** 破的全站纪录维度 */
  global: string[];
};

const NO_RECORD: RecordExempt = { exempt: false, personal: [], global: [] };

/** 3BV 限界片段（初 10 / 中 4 / 高 4，与 MIN_3BV_FOR_3BVS、records.ts 同口径） */
const B3BV_LIMIT = Prisma.sql`(CASE v.level WHEN 'beg' THEN 10 ELSE 4 END)`;

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
 * 本盘是否破纪录。入参全部来自上传解析后的权威值（bbbv=board_3bv，timeMs=real_time）。
 * noRecord（运气盘）不调用本函数——它本就不进任何纪录链。
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
    const time = timeMs > 0 ? timeMs : 0; // 纪录页口径 real_time>0（3BV=1 的 0ms 局不进纪录）
    const bvs = s["3bvs"] > 0 ? s["3bvs"] : 0; // 低于限界的负值/0 不是有效纪录
    const stnb = stnbOf(level, bbbv, timeMs); // 纯函数，与跑批/雷达 stnb 同公式
    if (!time && !bvs && !stnb) return NO_RECORD;

    const id = BigInt(uid);
    // ⚠️ Prisma 字段名是 camelCase（begTime / beg3bvs），级别前缀保持小写——
    // core pb 路由靠 Next 编译期处理、本模块经 Node 直跑时大写开头（BegTime）
    // 会直接 ValidationError（本地库实测证实）。
    const personal: string[] = [];
    const global: string[] = [];

    // 3BV 未达级别限界（初10/中4/高4）的盘成绩划负，不进任何纪录链——
    // 与全站查询的 board_3bv>=CASE、userstnb.ts 的 MIN_3BV_FOR_3BVS 同口径。
    // noRecord（3BV 低于级别下限）由上传路由在调用前拦掉，这里再挡限界内的运气盘。
    const belowLimit = bbbv < MIN_3BV_FOR_3BVS[level];
    if (belowLimit) return NO_RECORD;

    // ① 个人最好（FL/NF 分池）
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

    // ② 全站当前最好（三级，不按 FL/NF 拆池，与 /records 页面同口径）
    if (time) {
      const rows = await prisma.$queryRaw<{ best: number | null }[]>`
        SELECT MIN(vi.real_time) AS best
        FROM video v JOIN video_info vi ON vi.id = v.id
        WHERE v.level = ${level} AND v.status = ${VIDEO_STATUS.REVIEWED}
          AND vi.real_time > 0 AND vi.no_record = 0
      `;
      if (rows[0]?.best == null || time < Number(rows[0].best)) global.push("time");
    }
    if (bvs) {
      const rows = await prisma.$queryRaw<{ best: number | null }[]>`
        SELECT MAX(ROUND(vi.board_3bv * 1000000.0 / vi.real_time)) AS best
        FROM video v JOIN video_info vi ON vi.id = v.id
        WHERE v.level = ${level} AND v.status = ${VIDEO_STATUS.REVIEWED}
          AND vi.real_time > 0 AND vi.board_3bv >= ${B3BV_LIMIT} AND vi.no_record = 0
      `;
      if (rows[0]?.best == null || bvs > Number(rows[0].best)) global.push("3bvs");
    }
    if (stnb) {
      const rows = await prisma.$queryRaw<{ best: number | null }[]>`
        SELECT MAX(m.stnb) AS best
        FROM video v JOIN video_info vi ON vi.id = v.id JOIN video_metrics m ON m.id = v.id
        WHERE v.level = ${level} AND v.status = ${VIDEO_STATUS.REVIEWED}
          AND m.stnb > 0 AND vi.board_3bv >= ${B3BV_LIMIT} AND vi.no_record = 0
      `;
      if (rows[0]?.best == null || stnb > Number(rows[0].best)) global.push("stnb");
    }

    return { exempt: personal.length > 0 || global.length > 0, personal, global };
  } catch {
    return NO_RECORD;
  }
}
