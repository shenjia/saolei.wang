// 纪录页数据层（2026-10-28）
//
// 页面 /records（导航「下载」前「纪录」入口，张老师 2026-10-28 需求）：
// · 左侧一个大板块「纪录」：Title 右侧三筛选器（初级/中级/高级）切级别，
//   每级别三图（时间 / 3BV/s / STNB）纪录演变——与后台「纪录演变」同口径：
//   只取「每一次刷新纪录」的点（运行最小/最大窗口函数，PARTITION BY level 三级别一起算；
//   ⚠️ 窗口漏 PARTITION BY 会把低级别点被高级别压没——2026-10-28 本地实测踩过）。
//   级别专属色：初级绿 #a6e22e / 中级橙 #f79646 / 高级金 #fdc61a。
//   每点带创造者（uid/名字/sex/是否在榜/高级成绩快照），渲染层据此换算双体系称号
//   （TitleBadge 军衔随观看者体系切换，快照制口径与全站一致）。
// · 右侧八项「其他纪录」：人气（=总人气 user_stat.clicks，展示 xxx.xW）/
//   收集BV（=BV榜第一，getBvRanking total）/
//   上传录像 / 发表文章 / 发表评论 / 发表纪事 / 练习盘数 / 审核录像——各取 TOP1。
//
// 性能（2026-10-28 张老师定分层）：左侧曲线重查询+基本不变 → 24h 持久缓存
// （records-curves）；右侧七项轻查询 → 60s 短缓存（records-tops）。
// ⚠️ 2026-10-29 慢 SQL 巡检后「上传最多/审核最多」已改单表索引聚合（张老师
// 「按玩家 ID 直接 count」方案），不再有全表 GROUP BY 挤慢日志的问题。
// 载荷 ~200 点 + 7 行，远小于 2MB 上限；/records 已进 preheat.sh 预热清单。

import { unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { VIDEO_STATUS } from "./config";
import { getBvRanking } from "./queries";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export type RecordMetric = "time" | "3bvs" | "stnb";
export type RecordLevel = "beg" | "int" | "exp" | "total";

/** 破纪录点（值/时间为原值，称号在页面层批量换算后合成 DTO 传客户端） */
export interface RecordCurveRow {
  metric: RecordMetric;
  level: RecordLevel;
  vid: number;
  userId: number;
  /** 创造者名（chinese_name） */
  name: string;
  /** 创造者英文名（hover 气泡「姓名（英文名）#ID」用，2026-10-29） */
  englishName: string;
  /** 纪录值原值：time=毫秒；3bvs=×1000 整数；stnb=原值（2 位小数） */
  val: number;
  /** 上传时刻 Unix 秒（=纪录创造时间，与后台曲线同口径） */
  ct: number;
  sex: number;
  ranked: boolean;
  expTime: number;
}

/** 右侧「其他纪录」TOP1 行 */
export interface SiteTopRow {
  key: "views" | "bv" | "upload" | "post" | "comment" | "history" | "practice" | "review" | "donate";
  userId: number;
  name: string;
  /** 创造者英文名（hover 气泡「姓名（英文名）#ID」用，2026-10-29） */
  englishName: string;
  sex: number;
  ranked: boolean;
  expTime: number;
  val: number;
  /** 最近一次发生时刻 Unix 秒（人气=最近被访问、上传=最近一次上传……） */
  lastCt: number;
}

/** 三级别 3BV 限界（初 10 / 中 4 / 高 4，与 MIN_3BV_FOR_3BVS 一致；SQL 内用 CASE 展开）。
 *  ⚠️ 必须用 Prisma.sql 片段——$queryRaw tagged template 的 ${} 默认按绑定参数处理，
 *  裸字符串会被当值传参导致 `board_3bv >= 'CASE...'` 语义错误 */
const B3BV_CASE = Prisma.sql`(CASE v.level WHEN 'beg' THEN 10 ELSE 4 END)`;

/** 运气盘排除（2026-11-02 张老师定）：video_info.no_record=1（上传时低于级别 3BV 下限
 *  初 2/中 30/高 100 的盘）不记成绩，不进任何纪录链。历史录像恒 0 不受影响 */
const NO_RECORD_EXCLUDED = Prisma.sql`vi.no_record = 0`;

/** 九条纪录演变曲线（+总计当前纪录单点）：窗口查询逐级算，总计走快照单点 */
async function fetchRecordCurves(): Promise<RecordCurveRow[]> {
  // 时间纪录：运行最小 real_time（同值并列也取点，与后台 getRecordCurve 的 `<=` 一致）
  const timeRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; ename: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, u.english_name ename, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT 'time' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             vi.real_time AS val, v.create_time AS ct,
             MIN(vi.real_time) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0 AND ${NO_RECORD_EXCLUDED}
    ) t
    JOIN \`user\` u ON u.id = t.uid
    LEFT JOIN user_scores s ON s.id = t.uid
    WHERE t.val <= t.run
  `;

  // 3BV/s 纪录：运行最大（board_3bv×1e6/real_time，×1000 口径；board_3bv 过级别限界）
  const b3bvsRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; ename: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, u.english_name ename, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT '3bvs' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             ROUND(vi.board_3bv * 1000000.0 / vi.real_time) AS val, v.create_time AS ct,
             MAX(ROUND(vi.board_3bv * 1000000.0 / vi.real_time)) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0 AND vi.board_3bv >= ${B3BV_CASE}
        AND ${NO_RECORD_EXCLUDED}
    ) t
    JOIN \`user\` u ON u.id = t.uid
    LEFT JOIN user_scores s ON s.id = t.uid
    WHERE t.val >= t.run
  `;

  // STNB 纪录：运行最大 video_metrics.stnb（离线重放引擎算得；board_3bv 同限界口径）
  const stnbRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; ename: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, u.english_name ename, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT 'stnb' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             m.stnb AS val, v.create_time AS ct,
             MAX(m.stnb) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id JOIN video_metrics m ON m.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0 AND vi.board_3bv >= ${B3BV_CASE}
        AND ${NO_RECORD_EXCLUDED}
    ) t
    JOIN \`user\` u ON u.id = t.uid
    LEFT JOIN user_scores s ON s.id = t.uid
    WHERE t.val >= t.run
  `;

  // 总计纪录演变（2026-10-28 张老师追问「为什么总计不能有图表」——能）：
  // user_scores 虽是最新快照，但每位玩家三级「个人纪录事件」全在 video 里，
  // 按时间重放即可重建任意时点的三级最优——总和时间取 min、3BV/s 与 STNB
  // 之和取 max，全站运行极值每次刷新即曲线点。
  // 口径与排行页总计列一致：三级齐全才有总计；点带触发录像（可点击）。
  // 事件量 ~11 万（本地实测），SQL 窗口出事件流、TS 内存重放（<50ms，挂缓存）。
  const mkReplay = <T extends { uid: bigint; level: string; vid: bigint; val: number; ct: bigint }>(
    rows: T[],
    combine: (b: { beg: number; int: number; exp: number }) => number,
    better: (a: number, b: number) => boolean
  ) => {
    type Pt = { uid: number; vid: number; val: number; ct: number };
    const pts: Pt[] = [];
    const bests = new Map<number, { beg: number; int: number; exp: number }>();
    let best = -Infinity;
    const evs = rows
      .map((e) => ({ uid: Number(e.uid), level: e.level, vid: Number(e.vid), val: Number(e.val), ct: Number(e.ct) }))
      .sort((a, b) => a.ct - b.ct || a.vid - b.vid);
    for (const e of evs) {
      const b = bests.get(e.uid) ?? { beg: 0, int: 0, exp: 0 };
      b[e.level as "beg" | "int" | "exp"] = e.val;
      bests.set(e.uid, b);
      if (b.beg > 0 && b.int > 0 && b.exp > 0) {
        const sum = combine(b);
        if (best === -Infinity || better(sum, best)) {
          best = sum;
          pts.push({ uid: e.uid, vid: e.vid, val: sum, ct: e.ct });
        }
      }
    }
    return pts;
  };

  // ① 总计时间：三级个人最优 real_time 事件流，和取运行最小
  const timeEvents = await prisma.$queryRaw<{ uid: bigint; level: string; vid: bigint; val: number; ct: bigint }[]>`
    SELECT t.uid, t.level, t.vid, t.val, t.ct
    FROM (
      SELECT v.\`user\` uid, v.level, v.id vid, vi.real_time val, v.create_time ct,
             MIN(vi.real_time) OVER (PARTITION BY v.\`user\`, v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0 AND v.level IN ('beg','int','exp')
        AND ${NO_RECORD_EXCLUDED}
    ) t WHERE t.val <= t.run`;
  const totalTimePts = mkReplay(timeEvents, (b) => b.beg + b.int + b.exp, (a, b) => a < b);

  // ② 总计 3BV/s：三级个人最优（board_3bv×1e6/real_time，×1000 口径）事件流，和取运行最大
  const b3Events = await prisma.$queryRaw<{ uid: bigint; level: string; vid: bigint; val: number; ct: bigint }[]>`
    SELECT t.uid, t.level, t.vid, t.val, t.ct
    FROM (
      SELECT v.\`user\` uid, v.level, v.id vid, ROUND(vi.board_3bv * 1000000.0 / vi.real_time) val, v.create_time ct,
             MAX(ROUND(vi.board_3bv * 1000000.0 / vi.real_time)) OVER (PARTITION BY v.\`user\`, v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0 AND v.level IN ('beg','int','exp')
        AND vi.board_3bv >= ${B3BV_CASE} AND ${NO_RECORD_EXCLUDED}
    ) t WHERE t.val >= t.run`;
  const totalB3Pts = mkReplay(b3Events, (b) => b.beg + b.int + b.exp, (a, b) => a > b);

  // ③ 总计 STNB：三级个人最优 video_metrics.stnb 事件流，和取运行最大
  const stnbEvents = await prisma.$queryRaw<{ uid: bigint; level: string; vid: bigint; val: number; ct: bigint }[]>`
    SELECT t.uid, t.level, t.vid, t.val, t.ct
    FROM (
      SELECT v.\`user\` uid, v.level, v.id vid, m.stnb val, v.create_time ct,
             MAX(m.stnb) OVER (PARTITION BY v.\`user\`, v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) run
      FROM video v JOIN video_info vi ON vi.id = v.id JOIN video_metrics m ON m.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0 AND v.level IN ('beg','int','exp')
        AND vi.board_3bv >= ${B3BV_CASE} AND ${NO_RECORD_EXCLUDED}
    ) t WHERE t.val >= t.run`;

  const totalStnbPts = mkReplay(stnbEvents, (b) => b.beg + b.int + b.exp, (a, b) => a > b);

  // 曲线点创造者信息（三级各取点集批量补名字；点集小）
  const hydrate = async (
    metric: "time" | "3bvs" | "stnb",
    pts: { uid: number; vid: number; val: number; ct: number }[]
  ) => {
    if (!pts.length) return [] as { metric: string; level: string; vid: bigint; uid: bigint; name: string; ename: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[];
    const rows = await prisma.$queryRaw<
      { seq: number; vid: bigint; uid: bigint; name: string; ename: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
    >`
      SELECT t.seq, t.vid, u.id uid, u.chinese_name name, u.english_name ename, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
      FROM (
        ${Prisma.join(
          pts.map((p, i) => Prisma.sql`SELECT ${i} seq, ${p.vid} vid, ${p.uid} uid, ${p.val} val, ${p.ct} ct`),
          " UNION ALL "
        )}
      ) t
      JOIN \`user\` u ON u.id = t.uid
      LEFT JOIN user_scores s ON s.id = t.uid
      ORDER BY t.seq`;
    return rows.map((r) => ({ ...r, metric, level: "total" }));
  };
  const [totalTimeRows, totalB3Rows, totalStnbRows] = await Promise.all([
    hydrate("time", totalTimePts),
    hydrate("3bvs", totalB3Pts),
    hydrate("stnb", totalStnbPts),
  ]);

  // 三个查询行结构一致，统一归一化（总计三曲线并入，level='total'）
  return [...timeRows, ...b3bvsRows, ...stnbRows, ...totalTimeRows, ...totalB3Rows, ...totalStnbRows].map((r) => ({
    metric: r.metric as RecordMetric,
    level: r.level as RecordLevel,
    vid: N(r.vid),
    userId: N(r.uid),
    name: r.name,
    englishName: r.ename ?? "",
    // STNB 浮点尾差（83.40000152…）在展示层统一 2 位小数，这里保留原值
    val: Number(r.val),
    ct: N(r.ct),
    sex: N(r.sex),
    ranked: N(r.ustatus) === 0,
    expTime: N(r.exp_time),
  }));
}

/** 右侧八项 TOP1（每项一条 GROUP BY 取第一名 + 最近发生时间） */
async function fetchSiteTops(): Promise<SiteTopRow[]> {
  // 最多赞助（2026-11-02 张老师要求，纪录页右栏置顶）：每人 = donate 按 user 合计（分）；
  // ID 1（站长）特殊口径与个人主页一致 = max(−结余, 0)，
  // 结余 = 全站赞助收入（donate 全表合计，含匿名）− 全站支出（donate_expense 合计），
  // 垫付额为 0（结余转整）时不参与夺魁；last_ct 取其最近一次支出时刻。
  // donate 表行数量级极小，全表 GROUP BY 无性能顾虑。
  const donateTop = (async (): Promise<SiteTopRow | null> => {
    const [incomeAgg, expenseAgg] = await Promise.all([
      prisma.donate.aggregate({ _sum: { amount: true } }),
      prisma.donateExpense.aggregate({ _sum: { amount: true } }),
    ]);
    const bossVal = Math.max(
      N(expenseAgg._sum.amount) - N(incomeAgg._sum.amount),
      0,
    );
    const rows = await prisma.$queryRaw<{ uid: bigint; val: bigint; last_ct: bigint }[]>`
      SELECT d.\`user\` uid, SUM(d.amount) val, MAX(d.create_time) last_ct
      FROM donate d WHERE d.\`user\` > 0 GROUP BY d.\`user\`
    `;
    type Cand = { uid: number; val: number; lastCt: number };
    const cands: Cand[] = rows.map((r) => ({
      uid: N(r.uid), val: N(r.val), lastCt: N(r.last_ct),
    }));
    if (bossVal > 0) {
      const bossLast = await prisma.donateExpense.aggregate({ _max: { createTime: true } });
      const boss = { uid: 1, val: bossVal, lastCt: N(bossLast._max.createTime) };
      const i = cands.findIndex((c) => c.uid === 1);
      if (i >= 0) cands[i] = boss;
      else cands.push(boss);
    }
    cands.sort((a, b) => b.val - a.val || a.uid - b.uid);
    const top = cands[0];
    if (!top) return null;
    const info = await prisma.$queryRaw<{ name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null }[]>`
      SELECT u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time
      FROM \`user\` u LEFT JOIN user_scores s ON s.id = u.id WHERE u.id = ${top.uid}
    `;
    const i = info[0];
    if (!i) return null;
    return {
      key: "donate", userId: top.uid, name: i.name, englishName: i.ename ?? "", sex: N(i.sex),
      ranked: N(i.ustatus) === 0, expTime: N(i.exp_time), val: top.val, lastCt: top.lastCt,
    };
  })();

  // （收集BV最多已拆出 fetchSiteTops，见 getBvTopRow——2026-11-05 慢 SQL 巡检：
  // unstable_cache 嵌套调用会 bypass 内层缓存（unstable-cache.js isNestedUnstableCache
  // 分支直接跳过 get），本回调原先每 60s 重建一次就把 30 万行 fetchBvCollection 聚合
  // 直打 DB ~777 次/日；拆成顶层薄缓存后与 BV 榜同 1h 节奏，~24 次/日）

  // 上传录像最多：全部上传（含待审/屏蔽）。2026-10-29 张老师点破「按录像的玩家 ID 直接 count」——
  // 旧形态 JOIN user/user_scores 后才 GROUP BY，33 万行 × JOIN 探测 rowsExam 93 万（avg 5.59s 挤慢日志 Top5）；
  // 新形态 video 单表 GROUP BY user 取 Top1（FORCE INDEX video_user_level_idx：索引序=分组序免 Sort，
  // 与 10-23 BV 聚合修复同模式），再单行反查名字/军衔；last_ct 子查询同走该索引的 user 分区。
  // 生产只读验证与旧形态结果完全一致（uid/val/last_ct 三值同）。
  const uploadTop = (async (): Promise<SiteTopRow | null> => {
    const rows = await prisma.$queryRaw<{ uid: bigint; val: bigint; last_ct: bigint }[]>`
      SELECT t.uid, t.val,
        (SELECT MAX(v2.create_time) FROM video v2 WHERE v2.\`user\` = t.uid) last_ct
      FROM (
        SELECT v.\`user\` uid, COUNT(*) val
        FROM video v FORCE INDEX (video_user_level_idx)
        GROUP BY v.\`user\` ORDER BY val DESC LIMIT 1
      ) t
    `;
    const r = rows[0];
    if (!r) return null;
    const info = await prisma.$queryRaw<{ name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null }[]>`
      SELECT u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time
      FROM \`user\` u LEFT JOIN user_scores s ON s.id = u.id WHERE u.id = ${r.uid}
    `;
    const i = info[0];
    if (!i) return null;
    return {
      key: "upload", userId: N(r.uid), name: i.name, englishName: i.ename ?? "", sex: N(i.sex),
      ranked: N(i.ustatus) === 0, expTime: N(i.exp_time), val: N(r.val), lastCt: N(r.last_ct),
    };
  })();

  // 审核录像最多：video.review_user 计数（与后台「审核员工作量」同口径）。
  // 同 2026-10-29 改法：单表 GROUP BY review_user（FORCE INDEX video_review_user_status_idx）取 Top1，
  // 替代旧 JOIN 放大形态（avg 3.25s）；last_ct 取该审核员最近一次 review_time（同索引分区）。
  const reviewTop = (async (): Promise<SiteTopRow | null> => {
    const rows = await prisma.$queryRaw<{ uid: bigint; val: bigint; last_ct: bigint }[]>`
      SELECT t.uid, t.val,
        (SELECT MAX(v2.review_time) FROM video v2 WHERE v2.review_user = t.uid) last_ct
      FROM (
        SELECT v.review_user uid, COUNT(*) val
        FROM video v FORCE INDEX (video_review_user_status_idx)
        WHERE v.review_user > 0
        GROUP BY v.review_user ORDER BY val DESC LIMIT 1
      ) t
    `;
    const r = rows[0];
    if (!r) return null;
    const info = await prisma.$queryRaw<{ name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null }[]>`
      SELECT u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time
      FROM \`user\` u LEFT JOIN user_scores s ON s.id = u.id WHERE u.id = ${r.uid}
    `;
    const i = info[0];
    if (!i) return null;
    return {
      key: "review", userId: N(r.uid), name: i.name, englishName: i.ename ?? "", sex: N(i.sex),
      ranked: N(i.ustatus) === 0, expTime: N(i.exp_time), val: N(r.val), lastCt: N(r.last_ct),
    };
  })();

  const [views, post, comment, history, upload, review] = await Promise.all([
    // 人气最高：总人气（user_stat.clicks 旧站累计镜像，展示 xxx.xW；与用户卡片同源）
    prisma.$queryRaw<{ uid: bigint; name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time, us.clicks val, 0 last_ct
      FROM user_stat us JOIN \`user\` u ON u.id = us.id LEFT JOIN user_scores s ON s.id = u.id
      WHERE us.clicks > 0
      ORDER BY us.clicks DESC LIMIT 1
    `,
    // 发表文章最多：论坛主题数
    prisma.$queryRaw<{ uid: bigint; name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(p.create_time) last_ct
      FROM bbs_post p JOIN \`user\` u ON u.id = p.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY p.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 发表评论最多：录像评论数
    prisma.$queryRaw<{ uid: bigint; name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(c2.create_time) last_ct
      FROM comment c2 JOIN \`user\` u ON u.id = c2.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY c2.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 发表纪事最多：扫雷纪事条数
    prisma.$queryRaw<{ uid: bigint; name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.english_name ename, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(h.create_time) last_ct
      FROM history h JOIN \`user\` u ON u.id = h.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY h.\`user\` ORDER BY val DESC LIMIT 1
    `,
    uploadTop,
    reviewTop,
  ]);

  const pick = (
    key: SiteTopRow["key"],
    rows: { uid: bigint; name: string; ename: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]
  ): SiteTopRow | null => {
    const r = rows[0];
    if (!r) return null;
    return {
      key,
      userId: N(r.uid),
      name: r.name,
      englishName: r.ename ?? "",
      sex: N(r.sex),
      ranked: N(r.ustatus) === 0,
      expTime: N(r.exp_time),
      val: N(r.val),
      lastCt: N(r.last_ct),
    };
  };

  return [
    await donateTop,
    pick("views", views),
    upload,
    pick("post", post),
    pick("comment", comment),
    pick("history", history),
    review,
  ].filter((r): r is SiteTopRow => r !== null);
}

/** 左侧纪录曲线（2026-10-28 张老师定：持久化缓存——重查询+基本不变：
 *  全站纪录只有被打破才变，24h TTL 已远超实际变化频率；即便有新纪录，
 *  一天内旧曲线展示完全可接受。⚠️ 改曲线口径必须升版本号（v6 起：运气盘排除） */
export const getRecordCurves = unstable_cache(
  fetchRecordCurves,
  ["records-curves-v6"],
  { revalidate: 86400, tags: ["records-curves"] }
);

/** 右侧 TOP1（原 60s 短缓存；2026-11-05 慢 SQL 巡检后 v7：60→300s——预热 cron 每分钟
 *  打 /records，60s TTL 意味着几乎每次预热都全量重建八项查询；TOP1 排名变化本就低频
 *  （与曲线 24h、BV 1h 同向），300s 足够「准实时」。⚠️ 改 TOP1 口径必须升版本号。
 *  注意：BV 项已拆出本缓存（见 getBvTopRow）——unstable_cache 嵌套调用会 bypass
 *  内层缓存直查 DB（2026-11-05 实证：60s 重建 × fetchBvCollection 30 万行聚合
 *  = 慢日志 mixed 变体 777 次/日），任何想往 fetchSiteTops 里塞缓存查询的改动
 *  都要先想清楚这层嵌套 bypass 语义。 */
export const getSiteTops = unstable_cache(fetchSiteTops, ["records-tops-v7"], {
  revalidate: 300,
  tags: ["records-tops"],
});

/** 收集BV最多 = BV 榜第一（2026-10-28 张老师定口径；2026-11-05 从 fetchSiteTops
 *  拆出为顶层缓存调用）：getBvRanking 顶层调用时 fetchBvCollection 的 1h 缓存
 *  正常生效（嵌套时被 bypass，见上）；本缓存只罩「MAX(create_time) 单行反查」，
 *  与 BV 榜同 1h 节奏，口径变更（升 v）仅在取数逻辑改动时需要。 */
export const getBvTopRow = unstable_cache(
  async (): Promise<SiteTopRow | null> => {
    const bv = await getBvRanking("total", 1, 1);
    const top = bv.rows[0];
    if (!top) return null;
    const last = await prisma.$queryRaw<{ ct: bigint | null }[]>`
      SELECT MAX(v.create_time) ct
      FROM video v WHERE v.\`user\` = ${top.id} AND v.status = ${VIDEO_STATUS.REVIEWED}
    `;
    return {
      key: "bv",
      userId: top.id,
      name: top.chineseName,
      englishName: top.englishName ?? "",
      sex: top.sex,
      ranked: true, // fetchBvCollection 已过滤 u.status = 0
      expTime: top.expTime,
      val: top.total,
      lastCt: N(last[0]?.ct ?? 0),
    };
  },
  ["records-bv-top-v1"],
  { revalidate: 3600, tags: ["records-tops"] }
);

/** 纪录页数据入口（分层缓存出口；页面层勿再包 unstable_cache）。
 *  2026-11-05：BV 项独立缓存（getBvTopRow）——三个顶层 unstable_cache 并行调用，
 *  bv 按「views 之后、upload 之前」插回，保持右栏渲染顺序与拆分前完全一致
 *  （页面 pairs[curves.length + i] 按索引对齐军衔，顺序不能乱）。 */
export async function getRecordsPageData(): Promise<{ curves: RecordCurveRow[]; tops: SiteTopRow[] }> {
  const [curves, tops, bvTop] = await Promise.all([getRecordCurves(), getSiteTops(), getBvTopRow()]);
  const withBv: SiteTopRow[] = [];
  for (const row of tops) {
    withBv.push(row);
    if (bvTop && row.key === "views") withBv.push(bvTop);
  }
  // 兜底：views 项意外缺失时 BV 追加到队首之后（donate 恒存在，不至于丢失 BV 项）
  if (bvTop && !withBv.includes(bvTop) && withBv.length > 0) withBv.splice(1, 0, bvTop);
  return { curves, tops: withBv };
}
