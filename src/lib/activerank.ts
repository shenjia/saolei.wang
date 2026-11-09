// 活跃排行（2026-11-08 张老师需求）：近 7 日活跃玩家榜，排行导航「进步」后新增「活跃」tab。
//
// 列口径（张老师 01:35 定）：
//   初级/中级/高级 = 近 7 日该级别（录像上传数 + 练习完成盘数）合计
//   评论           = 近 7 日（录像评论 + 论坛回复）条数
//   活跃指数       = 练习 3BV 计点 + 录像级别加权分（初×1 中×2 高×10）+ 评论数
//   默认按活跃指数降序；初级/中级/高级/评论列可点击表头单独排序。
//
// 2026-11-08 性能改造：不再在每次页面请求中聚合 practice_daily/video/comment/bbs_reply。
// scripts/user-activity-snapshot-refresh.ts 每分钟全量刷新 user_activity_snapshot；
// 本模块只读快照。读取时仍 JOIN user.status=0，保证封禁立即生效；
// 其余内容状态变化最迟下一轮刷新纠正，刷新失败继续读旧快照，不回退实时聚合。

import { prisma } from "./db";

/** 排序键白名单 */
export type ActiveBy = "act" | "beg" | "int" | "exp" | "cmt";
export const ACTIVE_BYS: ActiveBy[] = ["act", "beg", "int", "exp", "cmt"];

export const ACTIVE_PAGE_SIZE = 20;

/** 排序 SQL 白名单：默认路径可命中 (active_points DESC,user_id ASC) 索引。 */
const ORDER_BY: Record<ActiveBy, string> = {
  act: "ORDER BY t.active_points DESC, t.user_id ASC",
  beg: "ORDER BY t.beg_count DESC, t.user_id ASC",
  int: "ORDER BY t.int_count DESC, t.user_id ASC",
  exp: "ORDER BY t.exp_count DESC, t.user_id ASC",
  cmt: "ORDER BY t.comment_count DESC, t.user_id ASC",
};

export interface ActiveRow {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  avatar: string;
  /** 地区（user.area 原值；展示层经 areaDisplay 合规化，2026-11-09 张老师要求加地区列） */
  area: string;
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

interface AggRow {
  uid: bigint;
  cb: number;
  ci: number;
  ce: number;
  cc: number;
  act: number;
  chinese_name: string;
  english_name: string;
  sex: number;
  avatar: string;
  area: string;
  exp_time: number | null;
}

/**
 * 活跃排行分页查询。by：排序键（act 默认 / beg / int / exp / cmt）。
 * 返回 rows（带显示字段与各分项）、total（快照内有效活跃总人数）、pageSize。
 */
export async function getActiveRanking(
  page: number,
  take = ACTIVE_PAGE_SIZE,
  by: ActiveBy = "act",
): Promise<{ rows: ActiveRow[]; total: number; pageSize: number }> {
  const offset = (page - 1) * take;
  // 仅从服务端白名单选择排序片段；运行时异常值回退默认活跃指数序。
  const orderBy = ORDER_BY[by] ?? ORDER_BY.act;
  const [rows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<AggRow[]>(
      `SELECT t.user_id uid, t.beg_count cb, t.int_count ci, t.exp_count ce,
              t.comment_count cc, t.active_points act,
              u.chinese_name, u.english_name, u.sex, u.avatar, u.area, sc.exp_time
       FROM user_activity_snapshot t
       JOIN user u ON u.id = t.user_id AND u.status = 0
       LEFT JOIN user_scores sc ON sc.id = t.user_id
       ${orderBy}
       LIMIT ? OFFSET ?`,
      BigInt(take),
      BigInt(offset),
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c
       FROM user_activity_snapshot t
       JOIN user u ON u.id = t.user_id AND u.status = 0`,
    ),
  ]);
  return {
    rows: rows.map((r) => ({
      id: Number(r.uid),
      chineseName: r.chinese_name,
      englishName: r.english_name,
      sex: r.sex,
      avatar: r.avatar,
      area: r.area ?? "",
      expTime: r.exp_time ?? 0,
      beg: Number(r.cb),
      int: Number(r.ci),
      exp: Number(r.ce),
      cmt: Number(r.cc),
      act: Number(r.act),
    })),
    total: Number(countRows[0]?.c ?? 0),
    pageSize: take,
  };
}
