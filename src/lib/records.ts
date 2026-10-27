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
// 性能：窗口函数扫 30 万行级 video，三组曲线串行 + 八项并行，全量挂 unstable_cache
// （10 分钟，载荷 ~200 个点 + 8 行，远小于 2MB 上限）；/records 已进 preheat.sh 清单。

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
  key: "views" | "bv" | "upload" | "post" | "comment" | "history" | "practice" | "review";
  userId: number;
  name: string;
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

/** 九条纪录演变曲线（+总计当前纪录单点）：窗口查询逐级算，总计走快照单点 */
async function fetchRecordCurves(): Promise<RecordCurveRow[]> {
  // 时间纪录：运行最小 real_time（同值并列也取点，与后台 getRecordCurve 的 `<=` 一致）
  const timeRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT 'time' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             vi.real_time AS val, v.create_time AS ct,
             MIN(vi.real_time) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0
    ) t
    JOIN \`user\` u ON u.id = t.uid
    LEFT JOIN user_scores s ON s.id = t.uid
    WHERE t.val <= t.run
  `;

  // 3BV/s 纪录：运行最大（board_3bv×1e6/real_time，×1000 口径；board_3bv 过级别限界）
  const b3bvsRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT '3bvs' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             ROUND(vi.board_3bv * 1000000.0 / vi.real_time) AS val, v.create_time AS ct,
             MAX(ROUND(vi.board_3bv * 1000000.0 / vi.real_time)) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0 AND vi.board_3bv >= ${B3BV_CASE}
    ) t
    JOIN \`user\` u ON u.id = t.uid
    LEFT JOIN user_scores s ON s.id = t.uid
    WHERE t.val >= t.run
  `;

  // STNB 纪录：运行最大 video_metrics.stnb（离线重放引擎算得；board_3bv 同限界口径）
  const stnbRows = await prisma.$queryRaw<
    { metric: string; level: string; vid: bigint; uid: bigint; name: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
  >`
    SELECT t.metric, t.level, t.vid, t.uid, u.chinese_name name, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
    FROM (
      SELECT 'stnb' AS metric, v.level, v.id AS vid, v.\`user\` AS uid,
             m.stnb AS val, v.create_time AS ct,
             MAX(m.stnb) OVER (PARTITION BY v.level ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) AS run
      FROM video v JOIN video_info vi ON vi.id = v.id JOIN video_metrics m ON m.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0 AND vi.board_3bv >= ${B3BV_CASE}
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
        AND vi.board_3bv >= ${B3BV_CASE}
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
        AND vi.board_3bv >= ${B3BV_CASE}
    ) t WHERE t.val >= t.run`;

  const totalStnbPts = mkReplay(stnbEvents, (b) => b.beg + b.int + b.exp, (a, b) => a > b);

  // 曲线点创造者信息（三级各取点集批量补名字；点集小）
  const hydrate = async (
    metric: "time" | "3bvs" | "stnb",
    pts: { uid: number; vid: number; val: number; ct: number }[]
  ) => {
    if (!pts.length) return [] as { metric: string; level: string; vid: bigint; uid: bigint; name: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[];
    const rows = await prisma.$queryRaw<
      { seq: number; vid: bigint; uid: bigint; name: string; val: number; ct: bigint; sex: number; ustatus: number; exp_time: bigint | null }[]
    >`
      SELECT t.seq, t.vid, u.id uid, u.chinese_name name, t.val, t.ct, u.sex, u.status ustatus, s.exp_time
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
  // 收集BV最多 = BV 榜第一（2026-10-28 张老师定口径）：直接复用排行页 getBvRanking
  // （total 列，COUNT DISTINCT board_3bv 聚合 + 1 小时缓存，与 BV 榜零口径差），
  // 日期取该用户最近一次通过审核的上传时刻（=最近一次收集发生时间）
  const bvTop = (async () => {
    const bv = await getBvRanking("total", 1, 1);
    const top = bv.rows[0];
    if (!top) return null;
    const last = await prisma.$queryRaw<{ ct: bigint | null }[]>`
      SELECT MAX(v.create_time) ct
      FROM video v WHERE v.\`user\` = ${top.id} AND v.status = ${VIDEO_STATUS.REVIEWED}
    `;
    return {
      key: "bv" as const,
      userId: top.id,
      name: top.chineseName,
      sex: top.sex,
      ranked: true, // fetchBvCollection 已过滤 u.status = 0
      expTime: top.expTime,
      val: top.total,
      lastCt: N(last[0]?.ct ?? 0),
    };
  })();

  const [views, upload, post, comment, history, review, bv] = await Promise.all([
    // 人气最高：总人气（user_stat.clicks 旧站累计镜像，展示 xxx.xW；与用户卡片同源）
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, us.clicks val, 0 last_ct
      FROM user_stat us JOIN \`user\` u ON u.id = us.id LEFT JOIN user_scores s ON s.id = u.id
      WHERE us.clicks > 0
      ORDER BY us.clicks DESC LIMIT 1
    `,
    // 上传录像最多：全部上传（含待审/屏蔽）
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(v.create_time) last_ct
      FROM video v JOIN \`user\` u ON u.id = v.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY v.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 发表文章最多：论坛主题数
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(p.create_time) last_ct
      FROM bbs_post p JOIN \`user\` u ON u.id = p.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY p.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 发表评论最多：录像评论数
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(c2.create_time) last_ct
      FROM comment c2 JOIN \`user\` u ON u.id = c2.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY c2.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 发表纪事最多：扫雷纪事条数
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(h.create_time) last_ct
      FROM history h JOIN \`user\` u ON u.id = h.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY h.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 审核录像最多：video.review_user 计数（与后台「审核员工作量」同口径）
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(v.review_time) last_ct
      FROM video v JOIN \`user\` u ON u.id = v.review_user LEFT JOIN user_scores s ON s.id = u.id
      WHERE v.review_user > 0
      GROUP BY v.review_user ORDER BY val DESC LIMIT 1
    `,
    bvTop,
  ]);

  const pick = (
    key: SiteTopRow["key"],
    rows: { uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]
  ): SiteTopRow | null => {
    const r = rows[0];
    if (!r) return null;
    return {
      key,
      userId: N(r.uid),
      name: r.name,
      sex: N(r.sex),
      ranked: N(r.ustatus) === 0,
      expTime: N(r.exp_time),
      val: N(r.val),
      lastCt: N(r.last_ct),
    };
  };

  return [
    pick("views", views),
    await bv,
    pick("upload", upload),
    pick("post", post),
    pick("comment", comment),
    pick("history", history),
    pick("review", review),
  ].filter((r): r is SiteTopRow => r !== null);
}

/** 纪录页全量数据（缓存 10 分钟；改口径升 key 版本丢旧缓存） */
export const getRecordsPageData = unstable_cache(
  async (): Promise<{ curves: RecordCurveRow[]; tops: SiteTopRow[] }> => {
    // 曲线重（窗口函数 30 万行，内部三查询串行）；八项较轻并行
    const curves = await fetchRecordCurves();
    const tops = await fetchSiteTops();
    return { curves, tops };
  },
  ["records-page-v5"], // v5（2026-10-28 四轮）：总计三指标全部事件重放出曲线
  { revalidate: 600 }
);
