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
// 值全部来自 user_activity_snapshot（近 7 日窗口，每分钟重算）。
//
// 绘制档位口径（2026-11-13 张老师定）：
//   比较范围 = 当前活跃指数 >0 的玩家（active_points>0 快照行，JOIN user.status=0）；
//   每轴名次 = 活跃玩家中该列严格大于本人值的行数 + 1（并列同名次，与榜单口径一致）；
//   ① 排名前 3 → 本轴画满（percent=100）；
//   ② 登录轴特殊：与第一名同值即画满（7 天封顶并列第一者众，不能只限前 3）；
//   ③ 该维数据为 0 → 回中心（percent=0）；
//   ④ 该维数据 >0 → 至少画一格（percent≥ 首环 15）；
//   ⑤ 其余按 名次/活跃玩家数 比率落档：p=(1−rank/N)×100，取 ≤p 的最大网格环。
//   网格环与 RadarChart.tsx 的 GRID_RINGS 同源（升级序 15/35/50/60/70/80/90/100）。
//
// 气泡第二行（2026-11-13 二批 张老师定，11:51 修正文案）：名次 ≤3 → 金色
//   「全网第一/第二/第三」（登录 rank=1 恒「全网并列第一」）；否则
//   「超过 xx% 的活跃玩家」，xx=(1−rank/N)×100——分母由全站用户改为活跃玩家数，
//   旧「全网第一」分支由序数文案覆盖。

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

/** 绘制档位 = 网格环（与 RadarChart.tsx GRID_RINGS 保持一致，升级序）；
 *  名次/人口比率落档时取 ≤p 的最大环，最低钳首环（>0 至少画一格）。 */
const RADAR_GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];

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
  /** 气泡第二行金色名次文案（2026-11-13 张老师定）：名次 ≤3 时置值——
   *  非登录轴「全网第一/第二/第三」；登录轴与第一同值（rank=1）恒「全网并列第一」
   *  （7 天封顶并列者众，「全网第一」会被误解为独占），rank 2/3 照常序数；
   *  RadarChart 以 .tip_first 金色渲染 */
  beatText?: string;
  /** 「超过 xx%」句尾人群词（2026-11-13 张老师定）：活跃雷达恒「活跃玩家」 */
  beatScope?: string;
}

/**
 * 某用户近 7 日六维活跃雷达。绘制档位（2026-11-13 张老师定，见顶部注释块）：
 *   比较范围 = active_points>0 的活跃玩家（JOIN user.status=0，封禁即时生效）；
 *   N = 活跃玩家数；每轴 rank = 活跃玩家中该列严格更大行数 + 1（并列同名次）；
 *   前 3 画满（登录轴改为「与第一同值即画满」）；0 值回中心；
 *   >0 至少首环一格；其余 p=(1−rank/N)×100 落最大 ≤p 的网格环。
 * 索引口径：六列均有 (col DESC, user_id ASC) 复合索引，快照几千行毫秒级。
 */
export async function getActiveRadar(
  userId: number,
): Promise<ActiveRadarDataPoint[]> {
  // 本人六列值一行取齐（不在快照 = 全 0 = 六维回中心）
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

  // 一次取齐：活跃玩家总数 N + 六列「严格大于本人值行数 worse / 与本人并列行数 ties」
  // （比较范围统一 = active_points>0，2026-11-13 张老师定；SUM 条件布尔 0/1，NULL 兜 0）
  const statRows = await prisma.$queryRawUnsafe<
    { n: bigint | number; bw: bigint | number; bt: bigint | number; iw: bigint | number; it: bigint | number; ew: bigint | number; et: bigint | number; cw: bigint | number; ct: bigint | number; ww: bigint | number; wt: bigint | number; lw: bigint | number; lt: bigint | number }[]
  >(
    `SELECT COUNT(*) n,
            COALESCE(SUM(t.beg_count > ?), 0) bw, COALESCE(SUM(t.beg_count = ?), 0) bt,
            COALESCE(SUM(t.int_count > ?), 0) iw, COALESCE(SUM(t.int_count = ?), 0) it,
            COALESCE(SUM(t.exp_count > ?), 0) ew, COALESCE(SUM(t.exp_count = ?), 0) et,
            COALESCE(SUM(t.comment_count > ?), 0) cw, COALESCE(SUM(t.comment_count = ?), 0) ct,
            COALESCE(SUM(t.watch_points > ?), 0) ww, COALESCE(SUM(t.watch_points = ?), 0) wt,
            COALESCE(SUM(t.login_points > ?), 0) lw, COALESCE(SUM(t.login_points = ?), 0) lt
     FROM user_activity_snapshot t
     JOIN user u ON u.id = t.user_id AND u.status = 0
     WHERE t.active_points > 0`,
    mine.beg ?? 0, mine.beg ?? 0,
    mine.int ?? 0, mine.int ?? 0,
    mine.exp ?? 0, mine.exp ?? 0,
    mine.cmt ?? 0, mine.cmt ?? 0,
    mine.watch ?? 0, mine.watch ?? 0,
    mine.login ?? 0, mine.login ?? 0,
  );
  const s = statRows[0];
  const statByKey = new Map<ActiveMetricKey, { worse: number; ties: number }>([
    ["beg", { worse: Number(s?.bw ?? 0), ties: Number(s?.bt ?? 0) }],
    ["int", { worse: Number(s?.iw ?? 0), ties: Number(s?.it ?? 0) }],
    ["exp", { worse: Number(s?.ew ?? 0), ties: Number(s?.et ?? 0) }],
    ["cmt", { worse: Number(s?.cw ?? 0), ties: Number(s?.ct ?? 0) }],
    ["watch", { worse: Number(s?.ww ?? 0), ties: Number(s?.wt ?? 0) }],
    ["login", { worse: Number(s?.lw ?? 0), ties: Number(s?.lt ?? 0) }],
  ]);
  const totalActive = Math.max(Number(s?.n ?? 0), 1);

  return RADAR_AXES.map(({ key, name }) => {
    const value = mine[key] ?? 0;
    if (!value) {
      // 无活跃值（不在快照或该列为 0）：回中心（percent=0，2026-11-13 张老师定）；
      // 气泡仍显示具体数据「本周完成 0 盘」（20:02 张老师定 hover 一律具体数据），
      // 第二行「超过 0% 的活跃玩家」（0% 也恒显第二行，2026-11-10 20:41 张老师定）
      return {
        name,
        score: "无",
        percent: 0,
        beatPct: 0,
        grade: "F",
        tipLabel: TIP_LABEL[key],
        tipValue: `0 ${TIP_UNIT[key]}`,
        labelValue: "0",
        beatScope: "活跃玩家",
      };
    }
    const st = statByKey.get(key)!;
    const worse = st.worse;
    // 活跃玩家中本数据名次（并列同名次，与榜单口径一致）
    const rank = worse + 1;
    // 画满判定：登录轴与第一同值（worse=0）即满；其余轴排名前 3（rank≤3）即满
    let percent: number;
    if (key === "login" ? worse === 0 : rank <= 3) {
      percent = 100;
    } else {
      // 名次/活跃玩家数比率落档：p=(1−rank/N)×100，取 ≤p 的最大网格环；
      // p 低于首环也钳到首环（>0 至少画一格，④）
      const p = (1 - rank / totalActive) * 100;
      percent = RADAR_GRID_RINGS[0];
      for (const ring of RADAR_GRID_RINGS) {
        if (ring <= p) percent = ring;
      }
    }
    // 气泡第二行（2026-11-13 张老师定，11:51 二次修正）：名次 ≤3 → 金色中文序数
    //「全网第一/第二/第三」（beatText 置值，RadarChart .tip_first 分支）；登录轴
    // rank=1（与第一同值）恒「全网并列第一」——7 天封顶并列者众，独占措辞误导；
    // 否则「超过 xx% 的活跃玩家」，xx=(1−rank/N)×100 取整（与绘图档位 p 同式）。
    // 旧「全网第一」（worse=0 且 ties=1）分支由序数文案覆盖，全站 total 分母弃用
    const beatPct = Math.floor((1 - rank / totalActive) * 100);
    const ORDINAL = ["全网第一", "全网第二", "全网第三"];
    const beatText =
      rank <= 3
        ? key === "login" && rank === 1
          ? "全网并列第一"
          : ORDINAL[rank - 1]
        : undefined;
    return {
      name,
      score: String(value),
      percent,
      beatPct,
      beatText,
      grade: "F",
      tipLabel: TIP_LABEL[key],
      tipValue: `${value} ${TIP_UNIT[key]}`,
      labelValue: String(labelPts[key] ?? 0),
      beatScope: "活跃玩家",
    };
  });
}
