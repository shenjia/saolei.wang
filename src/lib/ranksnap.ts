// 进步榜（移植 2008 版 Ranking_Grow + Top10_Grow）
// 2008 版：每日 job 滚动 31 张 Rank_N 表存 Player_Real_Rank（deploy/day.sql），
//          玩家表挂 Old_Rank（月度重置）算升降——本质是「30 天窗口名次对比」。
// 2026-10-22 重构（张老师定）：每人一行 + ranks JSON 滚动存 31 天总计时间名次，
//          每日定时脚本预计算 delta（窗口内最早可得快照名次 − 今日名次）落库。
// 2026-10-25 补封禁修正（张老师定）：基准日名次统计的是当天现役人群（含后来被封者），
//          今日名次只含现役——窗口内每个被封且基准日排在我前面的玩家，都会给我的
//          delta 白 +1（批量封禁会灌水整整一个窗口期）。修正 = delta −（现已封禁 ∧
//          基准日名次比我好）的人数：封禁者自己的 ranks JSON 历史保留（掉榜清理只
//          归零 delta 不删行），其基准日名次可查，故可离线修正。修正后 delta>0 的
//          语义 =「名次上升是超过还活着的对手，不是别人被抬走」（进步榜与每日一星
//          ② 路共用同一字段）。无需回填历史：delta 每日全量重算，上线次日 cron 自愈。

import { prisma } from "./db";
import { usersByIds, SCORE_FIELD, VIDEO_FIELD, type RankingRow, type UserBrief } from "./queries";
import { RANKING_BYS, byLevelOrder } from "./config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

function dateStr(d = new Date()): string {
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 滚动窗口大小（天）：与旧站 day.sql 的 Rank_1..Rank_31 一致 */
export const RANK_SNAPSHOT_WINDOW = 31;

/**
 * 每日刷新（幂等，cron 与页面惰性兜底共用同一实现）：
 * 1. 窗口函数算今日总计时间名次（MySQL 8+；封禁账号 status!=0 不进，旧站 Player_IsLive=1 口径）
 * 2. 每人 JSON 写入今日名次、剔除 >30 天旧键
 * 3. delta = 窗口内最早可得快照名次 − 今日名次（正=进步），baseDate 一并落库
 * 4. 封禁修正：delta -=（现已封禁 ∧ 基准日名次比我好）的人数（2026-10-25，见文件头说明）
 * force=false 时当日已刷新过（ranks 含今日键且行数>0）则跳过；force=true 强制重算（后台重算入口）。
 */
export async function refreshRankSnapshots(force = false): Promise<void> {
  const today = dateStr();

  if (!force) {
    // 幂等闸门：当日已刷新过（任一行 ranks 含今日键）即视为已刷新（刷新是全量单语句，要么全有要么全无）。
    // 2026-10-22 改判定源：原 JSON_CONTAINS_PATH 全表扫 ranks JSON（7 千行实测 1.9s，
    // /ranking 进步榜 tab 每次访问都触发）。刷新语句统一写 update_time=UNIX_TIMESTAMP()，
    // 故「今日已刷新」⇔ 存在 update_time >= 今日 0 点的行——走 delta 索引以外的
    // update_time 索引即可亚毫秒判定（索引见 schema RankSnapshot）。
    // 空表（首次部署）自然返回 0 行 → 照常刷新，语义与原 JSON 判定一致。
    const dayStartTs = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    })();
    const done = await prisma.$queryRawUnsafe<1[]>(
      `SELECT 1 FROM rank_snapshot WHERE update_time >= ? LIMIT 1`,
      dayStartTs
    );
    if (done.length > 0) return;
  }

  // 单条 SQL 完成全量重写（不把全表拉到 Node 侧）：
  //   t      = 今日总计时间榜（窗口函数，CAST SIGNED 防 ROW_NUMBER 的 UNSIGNED 参与减法溢出）
  //   p      = 每人现有 ranks 剔除 >30 天旧键（keys 展开 → JSON_EXTRACT 取值 → JSON_OBJECTAGG 回聚）
  //   merged = p + 今日名次（JSON_MERGE_PATCH；无历史的新玩家=只有今日键）
  //   base   = merged 最早日期（首日新玩家 base=今日 → delta=0 不上榜，符合预期）
  //   delta  = merged[base] − 今日名次（正=进步）
  // 未上榜玩家（sum_time=0/封禁）不 INSERT 新行；旧行若今日无名次，下方清理语句把 delta 归 0。
  // MySQL 兼容坑（2026-10-22 实证本地 9.2 / 生产 8.0）：
  //   ① JSON_TABLE 不能作相关子查询（1064）——只能横向 JOIN（含 GROUP BY 聚合成派生表）；
  //   ② JSON 值经 JSON_TABLE COLUMNS(br INT) 取出是 UNSIGNED，与 SIGNED 相减报 1690 溢出——
  //      两侧都显式 CAST AS SIGNED；
  //   ③ values 提取用 JSON_EXTRACT(列, CONCAT('$."', key, '"'))，不要第二个 JSON_TABLE（动态路径不支持）。
  await prisma.$executeRawUnsafe(
    `INSERT INTO rank_snapshot (user, ranks, delta, base_date, create_time, update_time)
     SELECT id, merged, delta, base, UNIX_TIMESTAMP(), UNIX_TIMESTAMP()
     FROM (
       SELECT q2.id, q2.merged,
              CAST(CAST(jt.br AS SIGNED) - CAST(q2.today_rank AS SIGNED) AS SIGNED) AS delta,
              q2.base
       FROM (
         SELECT b.id, b.today_rank, b.merged, MIN(kk.k) AS base
         FROM (
           SELECT t.id, t.r AS today_rank,
                  JSON_MERGE_PATCH(
                    COALESCE(p.pruned, CAST('{}' AS JSON)),
                    JSON_OBJECT(?, t.r)
                  ) AS merged
           FROM (
             SELECT s.id, CAST(ROW_NUMBER() OVER (ORDER BY s.sum_time ASC) AS SIGNED) r
             FROM user_scores s
             JOIN \`user\` u ON u.id = s.id AND u.status = 0
             WHERE s.sum_time > 0
           ) t
           LEFT JOIN (
             SELECT rs.user, JSON_OBJECTAGG(kk.k, JSON_EXTRACT(rs.ranks, CONCAT('$."', kk.k, '"'))) AS pruned
             FROM rank_snapshot rs
             JOIN JSON_TABLE(JSON_KEYS(rs.ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) kk
             WHERE kk.k > DATE_SUB(CURDATE(), INTERVAL 30 DAY)
             GROUP BY rs.user, rs.ranks
           ) p ON p.user = t.id
         ) b
         JOIN JSON_TABLE(JSON_KEYS(b.merged), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) kk
         GROUP BY b.id, b.today_rank, b.merged
       ) q2
       JOIN JSON_TABLE(
         CAST(CONCAT('[', CAST(JSON_UNQUOTE(JSON_EXTRACT(q2.merged, CONCAT('$."', q2.base, '"'))) AS CHAR), ']') AS JSON),
         '$[*]' COLUMNS(br INT PATH '$')) jt
     ) fin
     ON DUPLICATE KEY UPDATE
       ranks = VALUES(ranks),
       delta = VALUES(delta),
       base_date = VALUES(base_date),
       update_time = VALUES(update_time)`,
    today
  );

  // 掉榜清理：今日无名次的旧行 delta 归 0（不参与进步榜；JSON 历史保留自然滚动淘汰）
  await prisma.$executeRawUnsafe(
    `UPDATE rank_snapshot SET delta = 0, update_time = UNIX_TIMESTAMP()
     WHERE JSON_CONTAINS_PATH(ranks, 'one', ?) = 0 AND delta <> 0`,
    `$."${today}"`
  );

  // 封禁修正（2026-10-25 张老师定，见文件头说明）：
  //   delta -= |{已封禁玩家 b : b 在我的基准日名次比我好}|
  //   实现：先把所有已封禁者（user.status<>0）ranks JSON 里 30 天内的 (日期,名次)
  //   炸开成行（bx，被封后不再刷新、key 只增不减，必须按日期过滤），再与现役玩家的
  //   基准日配对比较；只修今日在榜（有今日 key）的现役行。边界自洽：
  //   · 封禁发生在基准日之前 → b 无基准日 key，bx 里没这行 → 不计；
  //   · 限时封禁到期回榜 → status 回 0，不再算 b；回榜者进今日榜压回名次，自动还原；
  //   · 新上榜玩家（base=今日）→ 被封者无今日 key（INSERT 只覆盖现役）→ 白捡为 0。
  //   JSON_TABLE 只能横向 JOIN 不能作相关子查询（MySQL 兼容坑②），故先炸开成派生表。
  await prisma.$executeRawUnsafe(
    `UPDATE rank_snapshot rs
     JOIN (
       SELECT u2.user AS uid, COUNT(*) AS ban_above
       FROM rank_snapshot u2
       JOIN \`user\` uu ON uu.id = u2.user AND uu.status = 0
       JOIN (
         SELECT b.user AS bid, kk.k AS d,
                CAST(JSON_UNQUOTE(JSON_EXTRACT(b.ranks, CONCAT('$."', kk.k, '"'))) AS SIGNED) AS r
         FROM rank_snapshot b
         JOIN \`user\` bu ON bu.id = b.user AND bu.status <> 0
         JOIN JSON_TABLE(JSON_KEYS(b.ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) kk
         WHERE kk.k > DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ) bx ON bx.d COLLATE utf8mb4_0900_ai_ci = u2.base_date
           AND bx.r < CAST(JSON_UNQUOTE(JSON_EXTRACT(u2.ranks, CONCAT('$."', u2.base_date, '"'))) AS SIGNED)
       WHERE u2.base_date <> ''
         AND JSON_CONTAINS_PATH(u2.ranks, 'one', ?)
       GROUP BY u2.id
     ) c ON c.uid = rs.user
     SET rs.delta = rs.delta - c.ban_above,
         rs.update_time = UNIX_TIMESTAMP()`,
    `$."${today}"`
  );
}

/** 兼容旧调用点（ranking 页惰性兜底）：保留旧函数名，内部转调刷新 */
export async function ensureTodaySnapshot(force = false): Promise<void> {
  await refreshRankSnapshots(force);
}

/**
 * 排行榜升降列（总计时间榜专用）：直读预计算 delta。
 * 返回 Map<userId, delta|null>——正=进步名次数，负=下降，0=持平/无基准（含新上榜首日）。
 */
export async function getSumTimeDeltas(ids: number[]): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  if (!ids.length) return map;
  const today = dateStr();
  const rows = await prisma.rankSnapshot.findMany({
    where: { user: { in: ids.map(BigInt) } },
    select: { user: true, delta: true, baseDate: true, ranks: true },
  });
  for (const r of rows) {
    // 今日未刷新（cron 失败且惰性兜底前的短暂窗口）→ 按持平 0 处理
    const ranks = (r.ranks ?? {}) as Record<string, number>;
    map.set(N(r.user), ranks[today] === undefined ? 0 : r.delta);
  }
  return map;
}

export interface GrowUser extends UserBrief {
  /** 本进步榜内的名次（按进步幅度排序后的榜序位次，第 1 页即 1—20 位） */
  rank: number;
  /** 今日全国总计时间榜名次（榜单口径备用，不再用于排名列展示） */
  todayRank: number;
  /** delta 基准日的全国总计时间榜名次（30 天窗口内最早可得快照） */
  yesterdayRank: number;
  delta: number;
}

/** 进步榜行（RankingRow 同构 + 升降数据），GrowFeed / API 共享 */
export type GrowRow = RankingRow & GrowUser;

/** 进步榜（2026-09-24 张老师要求改为雷界排行同款表格）：行=RankingRow 同构（8 列成绩+录像），
 *  rank=本进步榜内名次（2026-10-16 张老师定：按进步幅度排序后的榜序位次，非全国总计时间名次），
 *  delta=30 天窗口名次差（窗口内最早可得快照 − 今日，2026-10-22 重构口径，旧站同款 30 天窗口）；
 *  表内排序按 delta 降序（进步幅度大在前）。
 *  上榜条件（2026-10-16 张老师定）：delta > 0——持平/下降/新上榜一律不出现。
 *  查询（2026-10-22 起）：预计算 delta 单表直查，替代旧「今日快照 JOIN 昨日快照」双表算差。 */
export async function getGrowRanking(
  page: number,
  /** 返回条数（「加载更多」递增批量用；skip 恒按 base=20 的页锚点，take 才是行数） */
  take = 20
): Promise<{ rows: GrowRow[]; total: number; pageSize: number }> {
  // 惰性兜底：cron（00:05）失败或未跑时，当天首个进步榜访问触发刷新（幂等闸门在刷新内）
  await refreshRankSnapshots();
  const today = dateStr();

  const rows = await prisma.$queryRawUnsafe<
    { user: bigint; today_rank: number; base_rank: number; delta: number | bigint }[]
  >(
    // 封禁账号不上榜（旧站 Player_IsLive=1 口径）：读时 JOIN user 滤掉
    `SELECT s.user, CAST(JSON_UNQUOTE(JSON_EXTRACT(s.ranks, ?)) AS UNSIGNED) today_rank,
            CAST(JSON_UNQUOTE(JSON_EXTRACT(s.ranks, CONCAT('$."', s.base_date, '"'))) AS UNSIGNED) base_rank,
            s.delta
     FROM rank_snapshot s
     JOIN \`user\` u ON u.id = s.user AND u.status = 0
     WHERE s.delta > 0 AND JSON_CONTAINS_PATH(s.ranks, 'one', ?)
     ORDER BY s.delta DESC, CAST(JSON_UNQUOTE(JSON_EXTRACT(s.ranks, ?)) AS UNSIGNED) ASC
     LIMIT ? OFFSET ?`,
    `$."${today}"`,
    `$."${today}"`,
    `$."${today}"`,
    take, // 「加载更多」递增批量（take 可以 > 20，多拉本批行）
    (page - 1) * 20 // skip 恒按 base 20 的页锚点（页码语义不变）
  );
  const countRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) c FROM rank_snapshot s
     JOIN \`user\` u ON u.id = s.user AND u.status = 0
     WHERE s.delta > 0 AND JSON_CONTAINS_PATH(s.ranks, 'one', ?)`,
    `$."${today}"`
  );
  // 8 列成绩与录像：user_scores 主表批量取（与排行表同源）
  const scoreRows = rows.length
    ? await prisma.userScores.findMany({
        where: { id: { in: rows.map((r) => r.user) } },
      })
    : [];
  const scoreMap = new Map(scoreRows.map((s) => [s.id, s]));
  const authors = await usersByIds(rows.map((r) => N(r.user)));
  return {
    rows: rows.map((r, i) => {
      const brief: UserBrief = authors.get(N(r.user)) ?? {
        id: N(r.user),
        chineseName: "?",
        englishName: "",
        sex: 1,
      };
      const rec = (scoreMap.get(r.user) ?? {}) as unknown as Record<string, bigint | number | null>;
      const scores: Record<string, number> = {};
      const videos: Record<string, number> = {};
      for (const b of RANKING_BYS) {
        const lo = byLevelOrder(b);
        scores[b] = N(rec[SCORE_FIELD(lo.level, lo.order)] as number);
        videos[b] = lo.level === "sum" ? 0 : N(rec[VIDEO_FIELD(lo.level, lo.order)] as bigint);
      }
      return {
        ...brief,
        rank: (page - 1) * 20 + i + 1, // 排名列=本榜内名次（2026-10-16 张老师定，第 1 页即 1—20 位）
        scores,
        videos,
        todayRank: N(r.today_rank), // 全国总计时间名次保留在字段里备用
        yesterdayRank: N(r.base_rank), // 基准日名次（30 天窗口内最早快照）
        delta: N(r.delta),
      };
    }),
    total: N(countRows[0]?.c),
    pageSize: 20, // 返回值口径恒为 base 页大小（页码语义），take 只是本批行数
  };
}
