// 首页「今日练习」板块数据（2026-10-22 张老师要求；七轮改走 practice_daily 日汇总表）
// 口径不变（与后台仪表盘「今日练习」KPI 一致）：
// · 尝试盘数 = practice_daily 当日 plays（含踩雷、游客局，游客并入 user_id=0 聚合行）
// · 完成盘数 = 当日 wins（won=1）
// · 参与雷友 = 当日去重 user_id（user_id>0 才算「位」）
// · 我的完成/尝试 = 登录者当日行（未登录 0，前端走 localStorage）
// 表结构：每人每日一行（day 为 +08:00 切天序号），埋点路由 UPSERT 自增——
// 表体量 = 活跃练习者数 × 天数（一年仅数万行），无逐盘流水膨胀问题（张老师 2026-10-22 定）。
// 今日实时数不缓存（唯一键 (day,user_id) 点查毫秒级），走势挂 unstable_cache 300s
// （铁律：热点统计必须挂缓存）。
//
// 2026-11-11 张老师要求：首页趋势曲线改为只显示自己的活跃值曲线（原全网/我的
// 练习次数双线撤下，getTrendCached/getMineTrendCached 一并移除）。活跃值分日聚合
// 见 getMineActTrendCached；今日活跃值走 getRankedToday 口径（登录点无条件 +1）。

import { prisma } from "@/lib/db";
import { unstable_cache } from "next/cache";
import { dayStart } from "@/lib/admin/stats";
import { LEVEL_MIN_3BV, REVALIDATE_HOME_CACHE, VIDEO_STATUS } from "@/lib/config";
import { registerPreheat } from "@/lib/preheat";

export interface PracticeToday {
  /** 今日全网尝试盘数（含踩雷局、游客局；后台 KPI 同口径） */
  today: number;
  /** 今日全网完成盘数（won=1） */
  todayWon: number;
  /** 今日去重参与玩家数（仅登录态） */
  todayUsers: number;
  /** 我今日完成盘数（未登录 0） */
  mineWon: number;
  /** 我今日尝试盘数（未登录 0） */
  mine: number;
  /** 近 7 天我的活跃值走势（2026-11-11 张老师要求：首页趋势曲线改为只画自己活跃值，
   *  原全网/我的练习次数双线撤下；二轮改 30→7 天——act_points 11-08 才起记，30 天
   *  窗口前段全是贴底 0 无信息量，7 天每点都有意义）。不含今日——今日实时活跃值由
   *  getRankedToday 口径（登录点无条件 +1，查表有竞态）单独计算，渲染端拼在末位；
   *  未登录恒 []（活跃值恒 ≥1 必然登录态才有，游客无「自己」可画） */
  mineActTrend: number[];
}

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/**
 * 近 7 天我的分日活跃值（不含今天；2026-11-11 张老师要求首页趋势曲线改画自己活跃值，
 * 同日二轮定 7 天窗口——act_points 11-08 起记，30 天窗口前段全是 0）。
 * 口径与 getRankedToday 的今日活跃值（活跃榜 active_points 单日口径）严格一致，五源分日聚合：
 *   练习点（practice_daily.act_points，逐盘落库累计）+ 登录 1 点（user_daily_visit 打卡行）
 *   + 观看点（user_watch_daily 每 60000ms 记 1，按日 ROUND）+ 录像加权点（初×1 中×2 高×10，
 *   剔 Saolei.wang 排行局防双计）+ 评论/回复条数。今日点不在此查——getRankedToday 的
 *   登录点是无条件 +1（查打卡行有当日首访竞态），历史日无竞态走事实源。
 * uid 参与缓存 key 每人一份不串；per-user 索引点查/窗口聚合，毫秒级。
 */
const getMineActTrendCached = (uid: number) =>
  unstable_cache(
    async (): Promise<number[]> => {
      const fromIdx = Math.floor((dayStart(6) + 28800) / 86400);
      const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
      const fromTs = dayStart(6);
      const today0 = dayStart(0);
      const uidBig = BigInt(uid);
      const rows = await prisma.$queryRaw<Array<{ d: bigint; p: bigint }>>`
        SELECT t.day AS d, SUM(t.pts) AS p FROM (
          SELECT p.day AS day, p.act_points AS pts
          FROM practice_daily p
          WHERE p.user_id = ${uidBig} AND p.day >= ${fromIdx} AND p.day < ${todayIdx}
          UNION ALL
          SELECT FLOOR((v.create_time + 28800) / 86400) AS day,
                 SUM(v.level = 'beg') + 2 * SUM(v.level = 'int') + 10 * SUM(v.level = 'exp') AS pts
          FROM video v
          JOIN video_info vi ON vi.id = v.id AND vi.software <> 'Saolei.wang'
          WHERE v.\`user\` = ${uidBig}
            AND v.status <> ${VIDEO_STATUS.BANNED}
            AND v.create_time >= ${fromTs} AND v.create_time < ${today0}
          GROUP BY day
          UNION ALL
          SELECT FLOOR((c.create_time + 28800) / 86400) AS day, COUNT(*) AS pts
          FROM comment c
          WHERE c.\`user\` = ${uidBig} AND c.status = 0
            AND c.create_time >= ${fromTs} AND c.create_time < ${today0}
          GROUP BY day
          UNION ALL
          SELECT FLOOR((r.create_time + 28800) / 86400) AS day, COUNT(*) AS pts
          FROM bbs_reply r
          WHERE r.\`user\` = ${uidBig} AND r.status = 0
            AND r.create_time >= ${fromTs} AND r.create_time < ${today0}
          GROUP BY day
          UNION ALL
          SELECT w.day, ROUND(SUM(w.watch_ms) / 60000) AS pts
          FROM user_watch_daily w
          WHERE w.user_id = ${uidBig} AND w.day >= ${fromIdx} AND w.day < ${todayIdx}
          GROUP BY w.day
          UNION ALL
          SELECT dv.day, 1 AS pts
          FROM user_daily_visit dv
          WHERE dv.user_id = ${uidBig} AND dv.day >= ${fromIdx} AND dv.day < ${todayIdx}
        ) t GROUP BY t.day
      `;
      const map = new Map<number, number>(rows.map((r) => [N(r.d), N(r.p)]));
      const out: number[] = [];
      for (let i = 0; i < 7; i++) {
        const idx = fromIdx + i;
        if (idx >= todayIdx) break; // 今天及以后的桶由 getRankedToday 实时口径覆盖
        out.push(map.get(idx) ?? 0);
      }
      return out;
    },
    ["home-practice-mine-act-trend", `u${uid}`, "v2"],
    { revalidate: 300 }
  )();

/** 今日行（day, user_id）点查；userId=null 查游客聚合行（user_id=0） */
async function todayRow(userId: bigint | null): Promise<{ plays: number; wins: number } | null> {
  const rows = await prisma.$queryRaw<Array<{ plays: bigint; wins: bigint }>>`
    SELECT plays, wins FROM practice_daily
    WHERE day = ${Math.floor((dayStart(0) + 28800) / 86400)} AND user_id = ${userId ?? BigInt(0)}
  `;
  return rows[0] ? { plays: N(rows[0].plays), wins: N(rows[0].wins) } : null;
}

export async function getPracticeToday(uid?: number | null): Promise<PracticeToday> {
  const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
  // 实时数：全网今日（登录玩家汇总 + 游客 0 行单取）+ 参与玩家数 + 我的今日行
  // + 我的活跃值走势（2026-11-11 起首页曲线唯一数据源；未登录恒空）
  const [netRow, guestRow, usersAgg, mineRow, actTrend] = await Promise.all([
    prisma.$queryRaw<Array<{ p: bigint; w: bigint }>>`
      SELECT COALESCE(SUM(plays),0) AS p, COALESCE(SUM(wins),0) AS w
      FROM practice_daily WHERE day = ${todayIdx} AND user_id > 0
    `,
    todayRow(null),
    prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(*) AS c FROM practice_daily WHERE day = ${todayIdx} AND user_id > 0
    `,
    uid ? todayRow(BigInt(uid)) : Promise.resolve(null),
    uid ? getMineActTrendCached(uid) : Promise.resolve([]),
  ]);
  const today = N(netRow[0]?.p) + (guestRow?.plays ?? 0);
  const todayWon = N(netRow[0]?.w) + (guestRow?.wins ?? 0);
  const todayUsers = N(usersAgg[0]?.c);
  const mine = uid && mineRow ? mineRow.plays : 0;
  const mineWon = uid && mineRow ? mineRow.wins : 0;
  return {
    today,
    todayWon,
    todayUsers,
    mine,
    mineWon,
    mineActTrend: uid ? actTrend : [],
  };
}

// 首页访客路径自驱预热：null=全站口径（活跃值走势按 uid 各自缓存，无需预热）；
// 今日实时数是毫秒级点查，无需也无法预热
registerPreheat("practice-today", REVALIDATE_HOME_CACHE, () => getPracticeToday(null));

// ---------- 首页「今日已收集 x BV 创造 y PB 活跃值 z」行（2026-11-08 张老师改版） ----------
// 登录用户恒显（2026-11-08 改：原口径仅今日玩过排行模式才显示，活跃值入行后登录恒显，
// 无收获各项亮灰 0）。x=今日新收集 BV 总数（初/中/高合计，>0 绿色）、y=今日创造 PB 次数
// （金色，0 亮灰，颜色逻辑不变）、z=今日活跃值（2026-11-11 张老师定改活跃榜
// active_points 同口径的当日值，恒 ≥1，>0 绿色）。
// · 收集口径与个人主页收集格 / PB 核查路由完全同源（getUser3bvCollection）：
//   video JOIN video_info 取 board_3bv，status<>0（待审 10 也算收集，2026-10-28 口径）、
//   封禁连坐盘（status=0 且本人未封）保留；board_3bv ≥ LEVEL_MIN_3BV（初 2/中 30/高 100）。
//   「收集时刻」= 该 BV 首个录像的上传时刻（破纪录动态同口径：取上传时间）。
// · PB 口径（2026-10-28 21:15 张老师澄清定稿）＝列表黄点同源：打破「某级别
//   特定 BV 下本人最好成绩」的次数，直接计 video.pb_bv=1 的今日盘数
//   （上传时刻判定落列，NF/FL 不分池；**不是**全局历史纪录重放）。
//   收集 b/i/e 口径不变（收集格同源）。
// · 活跃值口径（2026-11-11 张老师定：恒 ≥1 不可能为 0——能看到本行必然当日已登录，
//   登录源至少 1 点打底）＝活跃榜 active_points 的当日单日口径（lib/useractivity.ts
//   六源去双计后五源）：练习点 + 登录 1 + 观看点 + 录像加权点 + 评论/回复条数。
//   游客不渲染本行，无归属问题。

export interface RankedToday {
  /** 今日是否玩过排行模式（首页行已登录恒显后仅作数据完整性标志，不再控制显隐） */
  ranked: boolean;
  /** 初级今日新收集 BV 数 */
  beg: number;
  /** 中级今日新收集 BV 数 */
  int: number;
  /** 高级今日新收集 BV 数 */
  exp: number;
  /** 今日创造 PB 次数（打破本BV最好成绩，与列表黄点 pb_bv 同源） */
  pb: number;
  /** 今日活跃值（2026-11-08 首页行新增展示项；2026-11-11 张老师定改活跃榜
   *  active_points 同口径的当日值：练习点+登录 1+观看点+录像点+评论/回复数，恒 ≥1） */
  act: number;
}

/**
 * 今日各渠道收获（首页/练习页/个人主页三处共用同源，2026-11-11 张老师定统一数据源）。
 * @param opts.loginFromTable 登录点取数方式：
 *   - 缺省 false：无条件 +1——首页/练习页口径，「能看到本行必然当日已登录」，
 *     且本请求 getSession 的 touchLastLogin 心跳正在异步 UPSERT 当日打卡行，
 *     查表有竞态（当日首访读不到行会误显 0）；
 *   - true：查 user_daily_visit 当日打卡行——个人主页口径，缓存打包访客无关
 *     （看别人的主页时，对方今天没来过就不能白送登录点；本人看自己首访当刻
 *     打卡行可能尚未落，60s 缓存过期后自然校正）。
 */
export async function getRankedToday(
  uid: number,
  opts?: { loginFromTable?: boolean },
): Promise<RankedToday> {
  const out: RankedToday = { ranked: false, beg: 0, int: 0, exp: 0, pb: 0, act: 0 };
  const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
  const today0 = dayStart(0);
  const uidBig = BigInt(uid);

  // 练习当日行 + 活跃值其余四源并行点查（全部单用户索引点查，毫秒级）
  const [row, watchRow, videoRow, cmtRow, replyRow, visitRow] = await Promise.all([
    prisma.practiceDaily.findUnique({
      where: { day_userId: { day: todayIdx, userId: uidBig } },
      select: { modeRanked: true, actPoints: true },
    }),
    // 观看点：当日观看毫秒每满 1 分钟记 1（与活跃快照 watch_points 同口径）
    prisma.$queryRaw<{ wp: bigint | null }[]>`
      SELECT ROUND(SUM(watch_ms) / 60000) AS wp FROM user_watch_daily
      WHERE user_id = ${uidBig} AND day = ${todayIdx}
    `,
    // 录像加权点：初×1 中×2 高×10，剔 Saolei.wang 排行局在线录像（排行局终局
    // 已照发练习埋点计过练习点，上传再计即双计——与活跃快照 video_points 同口径）
    prisma.$queryRaw<{ vs: bigint }[]>`
      SELECT COALESCE(SUM(v.level = 'beg') + 2 * SUM(v.level = 'int') + 10 * SUM(v.level = 'exp'), 0) AS vs
      FROM video v
      JOIN video_info vi ON vi.id = v.id AND vi.software <> 'Saolei.wang'
      WHERE v.\`user\` = ${uidBig}
        AND v.status <> ${VIDEO_STATUS.BANNED}
        AND v.create_time >= ${today0}
    `,
    // 评论/回复条数（活跃快照 comment_count 同口径：comment + bbs_reply 各计 1）
    prisma.$queryRaw<{ cc: bigint }[]>`
      SELECT COUNT(*) AS cc FROM comment
      WHERE \`user\` = ${uidBig} AND status = 0 AND create_time >= ${today0}
    `,
    prisma.$queryRaw<{ cc: bigint }[]>`
      SELECT COUNT(*) AS cc FROM bbs_reply
      WHERE \`user\` = ${uidBig} AND status = 0 AND create_time >= ${today0}
    `,
    // 登录点（loginFromTable 时生效）：当日打卡行，1 天 1 点
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM user_daily_visit
      WHERE user_id = ${uidBig} AND day = ${todayIdx}
    `,
  ]);

  // ③ 今日活跃值 z（2026-11-11 张老师定）＝活跃榜 active_points 的当日单日口径：
  //     练习点(practice_daily.act_points) + 登录 1 点 + 观看点 + 录像加权点 + 评论/回复数。
  //     登录点默认不查表无条件计入：本请求 getSession 的 touchLastLogin 心跳正在异步
  //     UPSERT 当日 user_daily_visit 打卡行，查表有竞态（当日首访读不到行会误显 0），
  //     而「正在看页面」本身就是当日访问的铁证；个人主页打包（loginFromTable）访客无关，
  //     改查打卡行（见 getRankedToday 注释）。
  out.act =
    Number(row?.actPoints ?? 0) +
    (opts?.loginFromTable ? Number(visitRow[0]?.n ?? 0) : 1) +
    Number(watchRow[0]?.wp ?? 0) +
    Number(videoRow[0]?.vs ?? 0) +
    Number(cmtRow[0]?.cc ?? 0) +
    Number(replyRow[0]?.cc ?? 0);

  if (!row || row.modeRanked <= 0) return out;
  out.ranked = true;

  // ① 今日新收集 BV（按级别分组去重计数）——收集格同源可见集合，单用户索引点查。
  //    口径＝「该 BV 首次收集发生在今天」：对 (level, board_3bv) 全历史取
  //    MIN(create_time) 作收集时刻（收集格同口径），HAVING 过滤——不能只看
  //    今天上传的录像里出现过哪些 3BV（旧版把以前收集过、今天重刷出 PB 的
  //    同值 3BV 也误计为「新收集」，2026-11-02 张老师报「刷了一堆初级 PB
  //    却显示收集 9 个初级 BV」实锤，生产验证 9→0）。
  const collected = await prisma.$queryRaw<{ lv: string; c: bigint }[]>`
    SELECT t.lv, COUNT(*) AS c FROM (
      SELECT v.level AS lv, vi.board_3bv
      FROM video v
      JOIN video_info vi ON vi.id = v.id
      JOIN \`user\` u ON u.id = v.\`user\`
      WHERE v.\`user\` = ${uidBig}
        AND (v.status <> ${VIDEO_STATUS.BANNED} OR u.status <> 0)
        AND vi.board_3bv >= CASE v.level
          WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
          WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
          ELSE ${LEVEL_MIN_3BV.exp} END
      GROUP BY v.level, vi.board_3bv
      HAVING MIN(v.create_time) >= ${today0}
    ) t GROUP BY t.lv`;
  for (const r of collected) {
    if (r.lv === "beg") out.beg = N(r.c);
    else if (r.lv === "int") out.int = N(r.c);
    else if (r.lv === "exp") out.exp = N(r.c);
  }

  // ② 今日 PB 次数：直接计 pb_bv=1 的今日盘（与列表黄点完全同源，
  //    上传时刻已判定落列；NF/FL 不分池，屏蔽盘不算）
  const pbRows = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM video v
    JOIN \`user\` u ON u.id = v.\`user\`
    WHERE v.\`user\` = ${uidBig}
      AND (v.status <> ${VIDEO_STATUS.BANNED} OR u.status <> 0)
      AND v.pb_bv = 1
      AND v.create_time >= ${today0}`;
  out.pb = N(pbRows[0]?.c);

  return out;
}
