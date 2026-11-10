// 活跃排行（2026-11-08 张老师需求）：近 7 日活跃玩家榜，排行导航「进步」后新增「活跃」tab。
//
// 列口径（张老师 01:35 定；2026-11-10 增「登录」「观看」列）：
//   初级/中级/高级 = 近 7 日该级别（录像上传数 + 练习完成盘数）合计
//   评论           = 近 7 日（录像评论 + 论坛回复）条数
//   观看           = 近 7 日观看录像时长折点（每满 1 分钟记 1 点，原地回放口径）
//   登录           = 近 7 日访问天数（每日访问雷网记 1 点，2026-11-10 张老师定）
//   活跃指数       = 练习 3BV 计点 + 录像级别加权分（初×1 中×2 高×10）+ 评论数 + 登录点 + 观看点
//   默认按活跃指数降序；数据列可点击表头单独排序。
//
// 2026-11-08 性能改造：不再在每次页面请求中聚合 practice_daily/video/comment/bbs_reply。
// scripts/user-activity-snapshot-refresh.ts 每分钟全量刷新 user_activity_snapshot；
// 本模块只读快照。读取时仍 JOIN user.status=0，保证封禁立即生效；
// 其余内容状态变化最迟下一轮刷新纠正，刷新失败继续读旧快照，不回退实时聚合。

import { prisma } from "./db";
import { radarDistributionRanks, radarGrade, radarPercent } from "./radar-standard.mjs";

/** 排序键白名单 */
export type ActiveBy = "act" | "beg" | "int" | "exp" | "cmt" | "watch" | "login";
export const ACTIVE_BYS: ActiveBy[] = ["act", "beg", "int", "exp", "cmt", "watch", "login"];

export const ACTIVE_PAGE_SIZE = 20;

/** 排序 SQL 白名单：默认路径可命中 (active_points DESC,user_id ASC) 索引。 */
const ORDER_BY: Record<ActiveBy, string> = {
  act: "ORDER BY t.active_points DESC, t.user_id ASC",
  beg: "ORDER BY t.beg_count DESC, t.user_id ASC",
  int: "ORDER BY t.int_count DESC, t.user_id ASC",
  exp: "ORDER BY t.exp_count DESC, t.user_id ASC",
  cmt: "ORDER BY t.comment_count DESC, t.user_id ASC",
  watch: "ORDER BY t.watch_points DESC, t.user_id ASC",
  login: "ORDER BY t.login_points DESC, t.user_id ASC",
};

/** 名次统计列白名单（getActiveRankOfUsers 用，与 ORDER_BY 同源） */
const ACTIVE_RANK_COLUMN: Record<ActiveBy, string> = {
  act: "active_points",
  beg: "beg_count",
  int: "int_count",
  exp: "exp_count",
  cmt: "comment_count",
  watch: "watch_points",
  login: "login_points",
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
  /** 观看：7 日观看录像时长折点（每满 1 分钟 1 点，2026-11-10 张老师定） */
  watch: number;
  /** 登录：7 日访问天数（每日访问记 1 点，2026-11-10 张老师定） */
  login: number;
  /** 活跃指数（练习点数 + 录像加权分 + 评论数 + 登录点 + 观看点） */
  act: number;
}

interface AggRow {
  uid: bigint;
  cb: number;
  ci: number;
  ce: number;
  cc: number;
  wp: number;
  lp: number;
  act: number;
  chinese_name: string;
  english_name: string;
  sex: number;
  avatar: string;
  area: string;
  exp_time: number | null;
}

/**
 * 活跃排行分页查询。by：排序键（act 默认 / beg / int / exp / cmt / watch / login）。
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
              t.comment_count cc, t.watch_points wp, t.login_points lp, t.active_points act,
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
      watch: Number(r.wp),
      login: Number(r.lp),
      act: Number(r.act),
    })),
    total: Number(countRows[0]?.c ?? 0),
    pageSize: take,
  };
}

/**
 * 批量求用户在活跃榜中的名次（2026-11-10 张老师要求：进步/活跃榜搜索与雷界榜一致）。
 * 口径与 getActiveRanking(by) 完全一致：榜内= 快照行且该列 >0（JOIN user.status=0
 * 封禁即时生效），排序该列 DESC、user_id ASC——名次 = 1 + 榜内严格更强的行数。
 * by 默认 act（活跃指数序，= 榜单默认形态）；切排序列后搜索/定位传同 by，口径一致。
 * 无快照行 / 该列 0 的 id 不出现在结果里（前端显示「未加入活跃排行」）。
 * 单条 SQL 区间统计（候选 ≤12，快照几千行毫秒级），与 queries.getRankOfUsers 同构；
 * 列名走 ACTIVE_RANK_COLUMN 白名单映射（Record 常量，无运行时注入面）。
 */
export async function getActiveRankOfUsers(
  ids: number[],
  by: ActiveBy = "act",
): Promise<Map<number, number>> {
  // 只接受正整数 id 后直拼（无注入面；与 getRankOfUsers 同款护栏）
  const uniq = [...new Set(ids.filter((i) => Number.isInteger(i) && i > 0))];
  if (!uniq.length) return new Map();
  const idList = uniq.join(",");
  const col = ACTIVE_RANK_COLUMN[by] ?? ACTIVE_RANK_COLUMN.act;
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; rk: bigint }[]>(
    `SELECT a.user_id id, 1 + (SELECT COUNT(*) FROM user_activity_snapshot b
          JOIN \`user\` ub ON ub.id = b.user_id AND ub.status = 0
        WHERE b.${col} > 0 AND (b.${col} > a.${col}
          OR (b.${col} = a.${col} AND b.user_id < a.user_id))) AS rk
      FROM user_activity_snapshot a
      JOIN \`user\` ua ON ua.id = a.user_id AND ua.status = 0
      WHERE a.${col} > 0 AND a.user_id IN (${idList})`,
  );
  return new Map(rows.map((r) => [Number(r.id), Number(r.rk)]));
}

// ---------- 个人主页「活跃」雷达（2026-11-10 张老师需求） ----------
// 六维 = 活跃排行页六个数据列（初级/中级/高级盘数、观看时长点、评论次数、登录天数），
// 值全部来自 user_activity_snapshot（近 7 日窗口，每分钟重算）。评级按该列在快照内
// 的名次映射实力雷达同款 23 档边界（radar-standard.mjs 的 radarDistributionRanks）：
// 严格更大者计数 = 名次（并列同名次，与各榜单口径一致）；某维活跃值为 0 → 恒 F。
// 只看榜内（该列 >0 的快照行）即「活跃排行中的名次」；0 值不在榜但按需求直落 F。

/** 六维定义：key=快照列名，name=轴名（与活跃排行页表头一致）。
 *  轴序（2026-11-10 张老师定，二改）：顶轴起顺时针＝登录、评论、高级、中级、初级、观看
 *  ——初中高三盘数轴收到底部（右下→底→左下），评论上移右上角，登录留顶、观看留左上 */
const RADAR_AXES: { key: ActiveMetricKey; name: string }[] = [
  { key: "login", name: "登录" },
  { key: "cmt", name: "评论" },
  { key: "exp", name: "高级" },
  { key: "int", name: "中级" },
  { key: "beg", name: "初级" },
  { key: "watch", name: "观看" },
];

type ActiveMetricKey = "beg" | "int" | "exp" | "cmt" | "watch" | "login";

const METRIC_COLUMN: Record<ActiveMetricKey, string> = {
  beg: "beg_count",
  int: "int_count",
  exp: "exp_count",
  cmt: "comment_count",
  watch: "watch_points",
  login: "login_points",
};

/** 气泡文案（2026-11-10 张老师定）：hover 显示具体数据，数值绿色（RadarChart tipLabel 分支） */
const TIP_LABEL: Record<ActiveMetricKey, string> = {
  beg: "本周完成",
  int: "本周完成",
  exp: "本周完成",
  cmt: "本周发表评论",
  watch: "本周观看录像",
  login: "本周登录",
};
const TIP_UNIT: Record<ActiveMetricKey, string> = {
  beg: "盘",
  int: "盘",
  exp: "盘",
  cmt: "条",
  watch: "分钟",
  login: "天",
};

/** 轴标签点数（2026-11-10 21:28 张老师定）：初/中/高标签读快照分级别点列
 *  beg_pts/int_pts/exp_pts（练习分级别点 + 录像级别加权，与活跃指数总分严格对齐——
 *  败局完成率折扣点无法从盘数反推故落列）；评论/观看/登录 1:1 即原列。
 *  METRIC_WEIGHT 已废弃删除。 */

/** 活跃雷达数据点（RadarChart 的 ActiveRadarPoint 同构；tipLabel/tipValue 可选，
 *  实力雷达不传走默认「超过 xx%」气泡分支，两者共用同一组件互不影响） */
export interface ActiveRadarDataPoint {
  name: string;
  score: string;
  percent: number;
  beatPct: number;
  grade: string;
  /** 气泡文案前缀（如「本周完成」） */
  tipLabel?: string;
  /** 气泡数值 + 单位（如「13 盘」），数值绿色加粗（RadarChart em.tip_green） */
  tipValue?: string;
  /** 轴标签顶行（2026-11-10 21:24 张老师定）：不带单位、显示换算后活跃值取整 */
  labelValue?: string;
}

/**
 * 某用户近 7 日六维活跃雷达。评级＝纯名次判定：
 *   榜 = 该列 >0 的快照行（JOIN user.status=0）；N = 榜内人口（COUNT）；
 *   R' = 1 + 榜内严格大于本人值的行数（并列同名次，与各榜单口径一致）；
 *   23 档名次边界 = radarDistributionRanks(N)；取首个 ranks[i] ≥ R' 的档。
 *   dist[i] = −ranks[i]（名次下界取负成 desc 值序），radarGrade(v, dist, "desc")
 *   与上述判定数学等价——v=0 占位（0 值档位恒 F 分支拦截，不入 radarGrade）。
 *   N 不足 550 时边界自动钳到 N（首档即 SSS），小 N 判级稳定（radar-standard 设计语义）。
 * 索引口径：六列均有 (col DESC, user_id ASC) 复合索引（本需求新增），TOP 23 与
 * COUNT/MAX 全走索引，快照几千行毫秒级。
 */
export async function getActiveRadar(
  userId: number,
): Promise<ActiveRadarDataPoint[]> {
  // 本人六列值一行取齐（不在快照 = 全 0 = 六维全 F）
  // ⚠️ int 是 MySQL 保留字，中级列别名用 mid 接收再映射；
  // pb/pi/pe = 分级别点数（练习分级点+录像加权，21:28 对齐总分用）
  const myRows = await prisma.$queryRawUnsafe<
    {
      beg: number; mid: number; exp: number; cmt: number; watch: number; login: number;
      pb: number; pi: number; pe: number;
    }[]
  >(
    `SELECT beg_count beg, int_count mid, exp_count exp, comment_count cmt,
            watch_points watch, login_points login,
            beg_pts pb, int_pts pi, exp_pts pe
     FROM user_activity_snapshot
     WHERE user_id = ?
     LIMIT 1`,
    BigInt(userId),
  );
  const mineRaw = myRows[0];
  const mine: Partial<Record<ActiveMetricKey, number>> = mineRaw
    ? {
        beg: Number(mineRaw.beg),
        int: Number(mineRaw.mid),
        exp: Number(mineRaw.exp),
        cmt: Number(mineRaw.cmt),
        watch: Number(mineRaw.watch),
        login: Number(mineRaw.login),
      }
    : {};
  /** 初/中/高标签值 = 分级别点列（练习+录像加权）；评论/观看/登录 = 原列 1:1。
   *  六轴 labelValue 之和恒等于 active_points（账目严格对齐）。 */
  const labelPts: Partial<Record<ActiveMetricKey, number>> = mineRaw
    ? {
        beg: Number(mineRaw.pb),
        int: Number(mineRaw.pi),
        exp: Number(mineRaw.pe),
        cmt: Number(mineRaw.cmt),
        watch: Number(mineRaw.watch),
        login: Number(mineRaw.login),
      }
    : {};

  // 六列一次取齐：榜内人口 n + 严格大于本人值行数 worse + 与本人并列行数 ties（含本人）
  const stats: { key: ActiveMetricKey; n: number; worse: number; ties: number }[] = [];
  for (const { key } of RADAR_AXES) {
    const col = METRIC_COLUMN[key];
    const rows = await prisma.$queryRawUnsafe<
      { n: bigint | number; worse: bigint | number; ties: bigint | number }[]
    >(
      `SELECT COUNT(*) n, COALESCE(SUM(t.${col} > ?), 0) worse, COALESCE(SUM(t.${col} = ?), 0) ties
       FROM user_activity_snapshot t
       JOIN user u ON u.id = t.user_id AND u.status = 0
       WHERE t.${col} > 0`,
      mine[key] ?? 0,
      mine[key] ?? 0,
    );
    stats.push({
      key,
      n: Number(rows[0]?.n ?? 0),
      worse: Number(rows[0]?.worse ?? 0),
      ties: Number(rows[0]?.ties ?? 0),
    });
  }
  const statByKey = new Map(stats.map((s) => [s.key, s]));

  // 总人口（2026-11-10 21:00 张老师定）：气泡百分位分母不再用榜内人数——大多数用户
  // 近 7 日无活跃值，只要该列有名次，就超过了「全部无活跃值用户 + 榜内严格更差者」，
  // 分母＝全站正常状态用户数（与各排行榜上榜人口同源 user.status=0）
  const totalRows = await prisma.$queryRawUnsafe<{ t: bigint | number }[]>(
    `SELECT COUNT(*) t FROM user WHERE status = 0`,
  );
  const total = Math.max(Number(totalRows[0]?.t ?? 0), 1);

  return RADAR_AXES.map(({ key, name }) => {
    const value = mine[key] ?? 0;
    if (!value) {
      // 无活跃值（不在快照或该列为 0）：恒 F，半径 0 贴心（张老师定，2026-11-10）；
      // 气泡仍显示具体数据「本周完成 0 盘」（20:02 张老师定 hover 一律具体数据）
      return {
        name,
        score: "无",
        percent: 0,
        beatPct: 0,
        grade: "F",
        tipLabel: TIP_LABEL[key],
        tipValue: `0 ${TIP_UNIT[key]}`,
        labelValue: "0",
      };
    }    const st = statByKey.get(key);
    const n = st?.n ?? 0;
    const worse = st?.worse ?? 0;
    const ties = Math.max(st?.ties ?? 1, 1);
    // 名次 R' = worse + 1；23 档名次下界取负成 desc 值序 → radarGrade(v=−R')
    // 恰好落在「ranks[i] ≥ R' 的最强档」（radarPosition 首个 dist[i] ≤ v）。
    const ranks = radarDistributionRanks(Math.max(n, 1));
    const dist = ranks.map((r) => -r);
    const v = -(worse + 1);
    // beatPct = 全站百分位（2026-11-10 21:00 张老师定）：分母=全站正常用户 total，
    // 超过者 = 全部无活跃值用户（total − 榜内 n）+ 榜内严格更差者（n − worse − ties）；
    // 并列者不算被超过。真独占榜首（worse=0 且 ties=1，仅非登录轴）→ 100「全网第一」；
    // 登录轴恒真实百分位（7 天封顶并列第一者众）
    const worseAll = total - n + (n - worse - ties);
    const beatPct =
      worse === 0 && ties === 1 && key !== "login" ? 100 : Math.floor((worseAll / total) * 100);
    return {
      name,
      score: String(value),
      percent: radarPercent(v, dist, "desc"),
      beatPct,
      grade: radarGrade(v, dist, "desc"),
      tipLabel: TIP_LABEL[key],
      tipValue: `${value} ${TIP_UNIT[key]}`,
      labelValue: String(labelPts[key] ?? 0),
    };
  });
}
