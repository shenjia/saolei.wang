// 活跃排行（2026-11-08 张老师需求）：近 7 日活跃玩家榜，排行导航「进步」后新增「活跃」tab。
//
// 列口径（张老师 01:35 定）：
//   初级/中级/高级 = 近 7 日该级别（录像上传数 + 练习完成盘数）合计
//   评论           = 近 7 日（录像评论 + 论坛回复）条数
//   活跃指数       = 练习 3BV 计点（practice_daily.act_points，口径同地区活跃指数）
//                  + 录像级别加权分（初×1 中×2 高×10）+ 评论数（每条 1 点）
//   默认按活跃指数降序；初级/中级/高级/评论列可点击表头单独排序。
//   发表文章不计（2026-11-08 二次修订：避免灌水）。
//
// 有效口径：全部来源 JOIN user u.status=0（封禁不计）；评论限 status 正常；
// 录像 status<>0（待审 10 也算「传过」，与地区活跃指数 v7 同口径）。
// 练习窗口按 +08:00 自然日（day >= 今日-6，同地区活跃指数 p7）；其余按滚动 7×86400。
//
// 实现：四源 UNION ALL 逐源按用户 GROUP BY 后外层再聚合——7 日活跃人口为数百~数千级，
// 一次聚合全量排序（filesort 小结果集可接受）；LIMIT/OFFSET 供「加载更多」翻页。
// 全程 ? 占位符传参（含 ORDER BY 的 CASE 映射），零插值点。

import { prisma } from "./db";

/** 排序键白名单 */
export type ActiveBy = "act" | "beg" | "int" | "exp" | "cmt";
export const ACTIVE_BYS: ActiveBy[] = ["act", "beg", "int", "exp", "cmt"];

export const ACTIVE_PAGE_SIZE = 20;

export interface ActiveRow {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  avatar: string;
  /** 高级最好成绩秒（军衔评估用；无成绩 0） */
  expTime: number;
  /** 初级：7 日录像上传数 + 练习完成盘数 */
  beg: number;
  /** 中级：同上 */
  int: number;
  /** 高级：同上 */
  exp: number;
  /** 评论：7 日录像评论 + 论坛回复条数 */
  cmt: number;
  /** 活跃指数（练习点数 + 录像加权分 + 评论数） */
  act: number;
}

/** 内层 UNION ALL（四源各自按用户聚合）；占位符依次 = dayW, tsW, tsW, tsW */
function unionSql(): string {
  return `SELECT g.uid uid,
         COALESCE(SUM(g.cb), 0) cb, COALESCE(SUM(g.ci), 0) ci, COALESCE(SUM(g.ce), 0) ce,
         COALESCE(SUM(g.cc), 0) cc, COALESCE(SUM(g.pts), 0) pts, COALESCE(SUM(g.vs), 0) vs
       FROM (
         SELECT p.user_id uid, SUM(p.wins_beg) cb, SUM(p.wins_int) ci, SUM(p.wins_exp) ce,
                0 cc, SUM(p.act_points) pts, 0 vs
         FROM practice_daily p JOIN user u ON u.id = p.user_id AND u.status = 0
         WHERE p.user_id > 0 AND p.day >= ?
         GROUP BY p.user_id
         UNION ALL
         SELECT v.user uid, SUM(v.level = 'beg') cb, SUM(v.level = 'int') ci, SUM(v.level = 'exp') ce,
                0 cc, 0 pts, SUM(v.level = 'beg') + 2 * SUM(v.level = 'int') + 10 * SUM(v.level = 'exp') vs
         FROM video v JOIN user u ON u.id = v.user AND u.status = 0
         WHERE v.status <> 0 AND v.create_time >= ?
         GROUP BY v.user
         UNION ALL
         SELECT c.user uid, 0 cb, 0 ci, 0 ce, COUNT(*) cc, COUNT(*) pts, 0 vs
         FROM comment c JOIN user u ON u.id = c.user AND u.status = 0
         WHERE c.status = 0 AND c.create_time >= ?
         GROUP BY c.user
         UNION ALL
         SELECT r.user uid, 0 cb, 0 ci, 0 ce, COUNT(*) cc, COUNT(*) pts, 0 vs
         FROM bbs_reply r JOIN user u ON u.id = r.user AND u.status = 0
         WHERE r.status = 0 AND r.create_time >= ?
         GROUP BY r.user
       ) g
       GROUP BY g.uid`;
}

interface AggRow {
  uid: bigint;
  cb: bigint;
  ci: bigint;
  ce: bigint;
  cc: bigint;
  pts: bigint;
  vs: bigint;
  chinese_name: string;
  english_name: string;
  sex: number;
  avatar: string;
  exp_time: number | null;
}

/**
 * 活跃排行分页查询。by：排序键（act 默认 / beg / int / exp / cmt）。
 * 返回 rows（带显示字段与各分项）、total（7 日活跃总人数）、pageSize。
 */
export async function getActiveRanking(
  page: number,
  take = ACTIVE_PAGE_SIZE,
  by: ActiveBy = "act",
): Promise<{ rows: ActiveRow[]; total: number; pageSize: number }> {
  const nowSec = Math.floor(new Date().getTime() / 1000);
  const dayW = Math.floor((nowSec + 28800) / 86400) - 6; // +08:00 切天，含今日共 7 天
  const tsW = nowSec - 7 * 86400;
  const offset = (page - 1) * take;
  const inner = unionSql();
  // ORDER BY 走 CASE 参数映射（by 白名单外的值落到 act），避免标识符插值
  const orderBy =
    "ORDER BY (CASE ? WHEN 'beg' THEN t.cb WHEN 'int' THEN t.ci WHEN 'exp' THEN t.ce WHEN 'cmt' THEN t.cc ELSE t.pts + t.vs END) DESC, t.uid ASC";
  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<AggRow[]>(
      `SELECT t.uid, t.cb, t.ci, t.ce, t.cc, t.pts, t.vs,
              u.chinese_name, u.english_name, u.sex, u.avatar, sc.exp_time
       FROM (${inner}) t
       JOIN user u ON u.id = t.uid
       LEFT JOIN user_scores sc ON sc.id = t.uid
       ${orderBy}
       LIMIT ? OFFSET ?`,
      dayW,
      tsW,
      tsW,
      tsW,
      by,
      BigInt(take),
      BigInt(offset),
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM (${inner}) t`,
      dayW,
      tsW,
      tsW,
      tsW,
    ),
  ]);
  return {
    rows: rows.map((r) => ({
      id: Number(r.uid),
      chineseName: r.chinese_name,
      englishName: r.english_name,
      sex: r.sex,
      avatar: r.avatar,
      expTime: r.exp_time ?? 0,
      beg: Number(r.cb),
      int: Number(r.ci),
      exp: Number(r.ce),
      cmt: Number(r.cc),
      // 活跃指数 = 练习点数(pts) + 录像加权分(vs) + 评论数(cc)
      act: Number(r.pts) + Number(r.vs) + Number(r.cc),
    })),
    total: Number(countRows[0]?.c ?? 0),
    pageSize: take,
  };
}
