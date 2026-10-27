// 纪录页数据层（2026-10-28）
//
// 页面 /records（导航「下载」前「纪录」入口，张老师 2026-10-28 需求）：
// · 左侧三级（初/中/高）× 三图（时间 / 3BV/s / STNB）纪录演变——与后台「纪录演变」同口径：
//   只取「每一次刷新纪录」的点（运行最小/最大窗口函数，PARTITION BY level 三级别一起算；
//   ⚠️ 窗口漏 PARTITION BY 会把低级别点被高级别压没——2026-10-28 本地实测踩过）。
//   每点带创造者（uid/名字/sex/是否在榜/高级成绩快照），渲染层据此换算双体系称号
//   （TitleBadge 军衔随观看者体系切换，快照制口径与全站一致）。
// · 右侧八项「其他纪录」：人气 / 收集BV / 上传录像 / 发表文章 / 发表评论 / 发表纪事 /
//   练习盘数 / 审核录像——各取 TOP1（值 + 最近一次发生时间）。
//
// 性能：窗口函数扫 30 万行级 video，三组曲线串行 + 八项并行，全量挂 unstable_cache
// （10 分钟，载荷 ~200 个点 + 8 行，远小于 2MB 上限）；/records 已进 preheat.sh 清单。

import { unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { VIDEO_STATUS } from "./config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export type RecordMetric = "time" | "3bvs" | "stnb";
export type RecordLevel = "beg" | "int" | "exp";

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

/** 九条纪录演变曲线：三条窗口查询（time/3bvs/stnb），每条内 PARTITION BY level 一次算三级别 */
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

  // 三个查询行结构一致，统一归一化
  return [...timeRows, ...b3bvsRows, ...stnbRows].map((r) => ({
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
type NormalizeInput = RecordCurveRow;
declare function normalize(...args: never[]): NormalizeInput[];

/** 右侧八项 TOP1（每项一条 GROUP BY 取第一名 + 最近发生时间） */
async function fetchSiteTops(): Promise<SiteTopRow[]> {
  const [views, bv, upload, post, comment, history, practice, review] = await Promise.all([
    // 人气最高：看地盘去重计数（user+ip+日，2008 版迁移口径）
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(c.create_time) last_ct
      FROM click c JOIN \`user\` u ON u.id = c.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY c.\`user\` ORDER BY val DESC LIMIT 1
    `,
    // 收集BV最多：已通过录像 board_3bv 求和
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, CAST(SUM(vi.board_3bv) AS SIGNED) val, MAX(v.create_time) last_ct
      FROM video v JOIN video_info vi ON vi.id = v.id JOIN \`user\` u ON u.id = v.\`user\` LEFT JOIN user_scores s ON s.id = u.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED}
      GROUP BY v.\`user\` ORDER BY val DESC LIMIT 1
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
    // 练习盘数最多：/online 练习记录
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(pl.create_time) last_ct
      FROM practice_log pl JOIN \`user\` u ON u.id = pl.user_id LEFT JOIN user_scores s ON s.id = u.id
      GROUP BY pl.user_id ORDER BY val DESC LIMIT 1
    `,
    // 审核录像最多：video.review_user 计数（与后台「审核员工作量」同口径）
    prisma.$queryRaw<{ uid: bigint; name: string; sex: number; ustatus: number; exp_time: bigint | null; val: bigint; last_ct: bigint }[]>`
      SELECT u.id uid, u.chinese_name name, u.sex, u.status ustatus, s.exp_time, COUNT(*) val, MAX(v.review_time) last_ct
      FROM video v JOIN \`user\` u ON u.id = v.review_user LEFT JOIN user_scores s ON s.id = u.id
      WHERE v.review_user > 0
      GROUP BY v.review_user ORDER BY val DESC LIMIT 1
    `,
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
    pick("bv", bv),
    pick("upload", upload),
    pick("post", post),
    pick("comment", comment),
    pick("history", history),
    pick("practice", practice),
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
  ["records-page-v1"],
  { revalidate: 600 }
);
