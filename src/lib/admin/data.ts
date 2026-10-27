// 后台列表 / 详情查询（2026-09-24 管理后台）
//
// 设计：
// · 列表一律「raw SQL 只取 id 页 + Prisma 批量补数据」，避免 30 万行大表的 N+1。
// · 一切用户输入走 ? 占位符绑定；只有列名/排序方向这种白名单枚举才拼进 SQL 串。
// · 后台每页 25 条。

import { prisma } from "@/lib/db";
import { title as assessTitle } from "@/lib/assess";
import { getThunderKingId } from "@/lib/title-system";
import { usersByIds, type UserBrief } from "@/lib/queries";
import { BBS_BOARD_NAMES, BBS_BOARDS, ubb } from "@/lib/bbs";
import { VIDEO_STATUS, type VideoLevel } from "@/lib/config";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { decodeLegacyEntities } from "@/lib/format";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export const ADMIN_PAGESIZE = 25;

// ---------- 玩家 ----------

export interface AdminUserRow extends UserBrief {
  username: string;
  area: string;
  status: number;
  role: number;
  createTime: number;
  lastLoginTime: number;
  /** 封禁截止 Unix 秒（仅 status=-1 时有意义；0=永久） */
  banUntil: number;
  /** 反作弊处置（2026-10-27）：练习页排名模式禁用截止 / 低信任组截止（0=无标记） */
  rankBanUntil: number;
  lowTrustUntil: number;
  title: string;
  sumTime: number;
  /** 录像总数 */
  videos: number;
  /** 可信用户组（2026-10-24）：录像分拣不检查 STNB 触发器 */
  trusted: boolean;
}

const USER_ORDERS: Record<string, string> = {
  reg: "u.create_time DESC, u.id DESC",
  old: "u.create_time ASC, u.id ASC",
  last: "u.last_login_time DESC, u.id DESC",
  sum: "(s.sum_time IS NULL OR s.sum_time = 0) ASC, s.sum_time ASC",
  name: "u.chinese_name ASC, u.id ASC",
};

export interface UserFilter {
  q?: string;
  status?: string;
  role?: string;
  sex?: string;
  area?: string;
  ranked?: string;
  /** 称号体系偏好（仪表盘环形图点击穿透）：c=旧版人神界 / m=军衔制 */
  title?: string;
  order?: string;
  page?: number;
}

/** 列表筛选条件 → SQL 片段 + 参数（页面与「导出/计数」共用） */
function userWhere(f: UserFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const q = (f.q ?? "").trim();
  if (q) {
    // 录像标识（user_sig.signature，上传录像时注册）检索：EXPLAIN 下 OR+EXISTS 会全表扫
    // user，改用 IN 子查询（user_sig 仅 1.6 万行、signature 有唯一索引，实测 <60ms）
    const sigSub = "(u.id IN (SELECT user FROM user_sig WHERE signature LIKE ?))";
    if (/^\d+$/.test(q)) {
      // 纯数字：ID 精确匹配 + 标识模糊（存在纯数字标识如 "638"，只按 ID 会漏）
      conds.push(`(u.id = ? OR ${sigSub})`);
      const like = `%${q}%`;
      params.push(BigInt(q), like);
    } else {
      conds.push(
        `(u.chinese_name LIKE ? OR u.english_name LIKE ? OR a.username LIKE ? OR i.nickname LIKE ? OR ${sigSub})`
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
  }
  if (f.status === "banned") conds.push("u.status <> 0");
  if (f.status === "normal") conds.push("u.status = 0");
  if (f.role && /^\d+$/.test(f.role)) {
    conds.push("a.role = ?");
    params.push(parseInt(f.role, 10));
  }
  if (f.sex === "1" || f.sex === "0") {
    conds.push("u.sex = ?");
    params.push(parseInt(f.sex, 10));
  }
  if (f.area) {
    conds.push("u.area = ?");
    params.push(f.area);
  }
  if (f.ranked === "1") conds.push("s.sum_time > 0");
  if (f.ranked === "0") conds.push("(s.sum_time IS NULL OR s.sum_time = 0)");
  // 称号体系偏好筛选（2026-10-23 仪表盘环形图点击穿透）：与 getTitlePrefCounts 同口径——
  // 环形图只统计 user_info 有行的玩家（未存过资料不在任何一段），故用 EXISTS 而非 LEFT JOIN 判空；
  // 'c'=旧版人神界称号；'m'=军衔制（含脏值，脏值同按军衔渲染）
  if (f.title === "c") conds.push("EXISTS (SELECT 1 FROM user_info ti WHERE ti.id = u.id AND ti.title_pref = 'c')");
  else if (f.title === "m")
    conds.push("EXISTS (SELECT 1 FROM user_info ti WHERE ti.id = u.id AND ti.title_pref IS NOT NULL AND ti.title_pref <> 'c' AND ti.title_pref <> '')");
  return { sql: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

const USER_FROM = `FROM user u
  LEFT JOIN user_auth a ON a.id = u.id
  LEFT JOIN user_scores s ON s.id = u.id
  LEFT JOIN user_info i ON i.id = u.id`;

export async function getUserList(
  f: UserFilter
): Promise<{ rows: AdminUserRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const { sql, params } = userWhere(f);
  const order = USER_ORDERS[f.order ?? "reg"] ?? USER_ORDERS.reg;
  // 纯数字搜索=按 ID 找人（2026-10-27）：ID 精确命中置顶，避免被录像标识/账号模糊命中淹没
  // （q=1 曾命中 373 人、ID=1 按注册时间排到第 15 页翻不到）
  const q = (f.q ?? "").trim();
  let orderSql = order;
  const orderParams: unknown[] = [];
  if (/^\d+$/.test(q)) {
    orderSql = `(u.id = ?) DESC, ${order}`;
    orderParams.push(BigInt(q));
  }

  const [ids, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT u.id ${USER_FROM} ${sql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      ...params,
      ...orderParams,
      ADMIN_PAGESIZE,
      (page - 1) * ADMIN_PAGESIZE
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c ${USER_FROM} ${sql}`, ...params),
  ]);

  const uidList = ids.map((r) => N(r.id));
  const bigIds = uidList.map(BigInt);
  const [users, auths, scores, videoCounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: bigIds } } }),
    prisma.userAuth.findMany({ where: { id: { in: bigIds } }, select: { id: true, username: true, role: true } }),
    prisma.userScores.findMany({ where: { id: { in: bigIds } } }),
    uidList.length
      ? prisma.$queryRawUnsafe<{ user: bigint; c: bigint }[]>(
          `SELECT user, COUNT(*) c FROM video WHERE user IN (${uidList.map(() => "?").join(",")}) GROUP BY user`,
          ...bigIds
        )
      : Promise.resolve([] as { user: bigint; c: bigint }[]),
  ]);

  const uMap = new Map(users.map((u) => [N(u.id), u]));
  const authMap = new Map(auths.map((a) => [N(a.id), a]));
  const scoreMap = new Map(scores.map((s) => [N(s.id), s]));
  const vcMap = new Map(videoCounts.map((v) => [N(v.user), N(v.c)]));
  // 2026-10-19 总司令=雷界第一人特判（后台实时视角）
  const king = await getThunderKingId();

  const rows: AdminUserRow[] = [];
  for (const id of uidList) {
    const u = uMap.get(id);
    if (!u) continue;
    const auth = authMap.get(id);
    const sumTime = N(scoreMap.get(id)?.sumTime);
    const expTime = N(scoreMap.get(id)?.expTime);
    rows.push({
      id,
      chineseName: u.chineseName,
      englishName: u.englishName,
      sex: u.sex,
      username: auth?.username ?? "",
      area: u.area,
      status: u.status,
      role: auth?.role ?? 0,
      createTime: N(u.createTime),
      lastLoginTime: N(u.lastLoginTime),
      banUntil: N(u.banUntil),
      rankBanUntil: N(u.rankBanUntil),
      lowTrustUntil: N(u.lowTrustUntil),
      title: await assessTitle(expTime, king > 0 && king === id),
      sumTime,
      videos: vcMap.get(id) ?? 0,
      trusted: u.trusted,
    });
  }

  return { rows, total: N(countRows[0]?.c), pageSize: ADMIN_PAGESIZE, page };
}

export interface AdminUserDetail {
  row: AdminUserRow;
  /** 反作弊标记生效中（low_trust_until 未到期，数据层算好时效） */
  lowTrustFlagged: boolean;
  /** 练习页排名模式禁用生效中（rank_ban_until 未到期） */
  rankBanned: boolean;
  /** 排名禁用截止 Unix 秒（详情页倒计时用；0=无标记） */
  rankBanUntil: number;
  /** G1 排名行为审计累计（2026-10-27）；null=该玩家还没有排名局上传 */
  rankedAudit: {
    games: number;
    clicks: number;
    blindClicks: number;
    flags: number;
    blindFlags: number;
    blindRate: number;
    flagPrecision: number;
    suspicious: boolean;
  } | null;
  qq: string;
  nickname: string;
  mouse: string;
  pad: string;
  interest: string;
  loginTimes: number;
  loginIp: string;
  /** 防小号（2026-10-19）：注册 IP（落库一次）与最近登录 IP（setSession 实时刷新） */
  registerIp: string;
  lastLoginIp: string;
  clicks: number;
  newsCount: number;
  commentCount: number;
  bbsCount: number;
  /** 论坛主题总数（含已删除/待审，注销账号闸门口径） */
  postTotal: number;
  messageCount: number;
  /** 总计时间名次（0 = 未上榜） */
  sumRank: number;
  ranks: { beg: number; int: number; exp: number };
  recentVideos: { id: number; level: string; status: number; createTime: number; realTime: number; board3bv: number }[];
  oauth: { provider: string; nickname: string; createTime: number }[];
  recentLogs: { action: string; detail: string; createTime: number; user: number }[];
}

export async function getUserDetailAdmin(id: number): Promise<AdminUserDetail | null> {
  const uid = BigInt(id);
  const [user, auth, score, info, stat] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid } }),
    prisma.userAuth.findUnique({ where: { id: uid } }),
    prisma.userScores.findUnique({ where: { id: uid } }),
    prisma.userInfo.findUnique({ where: { id: uid } }),
    prisma.userStat.findUnique({ where: { id: uid } }),
  ]);
  if (!user) return null;

  const [newsCount, commentCount, bbsCount, postTotal, messageCount, clicks, videos, oauth, logs] = await Promise.all([
    prisma.news.count({ where: { user: uid } }),
    prisma.comment.count({ where: { user: uid, status: 0 } }),
    prisma.bbsPost.count({ where: { user: uid, status: 0 } }),
    prisma.bbsPost.count({ where: { user: uid } }),
    prisma.message.count({ where: { toUser: uid } }),
    prisma.click.count({ where: { user: uid } }),
    prisma.video.findMany({
      where: { user: uid },
      orderBy: { id: "desc" },
      take: 10,
      select: { id: true, level: true, status: true, createTime: true },
    }),
    prisma.userOauth.findMany({ where: { userId: uid }, select: { provider: true, nickname: true, createTime: true } }),
    prisma.adminLog.findMany({ where: { target: "user", targetId: uid }, orderBy: { id: "desc" }, take: 10 }),
  ]);

  const infos = videos.length
    ? await prisma.videoInfo.findMany({ where: { id: { in: videos.map((v) => v.id) } } })
    : [];
  const infoMap = new Map(infos.map((i) => [N(i.id), i]));

  const sumTime = N(score?.sumTime);
  const expTime = N(score?.expTime);
  // 名次 = 成绩更好的人数 + 1（同分并列取小）；封禁账号不上榜，故 join user.status = 0
  const rankRows = sumTime
    ? await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM user_scores s JOIN \`user\` u ON u.id = s.id AND u.status = 0
          WHERE s.sum_time > 0 AND s.sum_time < ?`,
        sumTime
      )
    : [];

  // 名次 = 成绩更好的人数 + 1（同分并列取小）；SQL 里必须用 snake_case 列名（Prisma 字段是 camelCase）
  const [begRank, intRank, expRank] = await Promise.all(
    (
      [
        ["beg_time", score?.begTime],
        ["int_time", score?.intTime],
        ["exp_time", score?.expTime],
      ] as [string, number | null | undefined][]
    ).map(async ([col, raw]) => {
      const v = N(raw);
      if (!v) return 0;
      const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM user_scores s JOIN \`user\` u ON u.id = s.id AND u.status = 0
          WHERE s.${col} > 0 AND s.${col} < ?`,
        v
      );
      return N(rows[0]?.c) + 1;
    })
  );

  const brief = (await usersByIds([id])).get(id) ?? {
    id,
    chineseName: user.chineseName,
    englishName: user.englishName,
    sex: user.sex,
  };

  return {
    row: {
      ...brief,
      username: auth?.username ?? "",
      area: user.area,
      status: user.status,
      role: auth?.role ?? 0,
      createTime: N(user.createTime),
      lastLoginTime: N(user.lastLoginTime),
      banUntil: N(user.banUntil),
      rankBanUntil: N(user.rankBanUntil),
      lowTrustUntil: N(user.lowTrustUntil),
      title: await assessTitle(expTime, (await getThunderKingId()) === id),
      sumTime,
      videos: await prisma.video.count({ where: { user: uid } }),
      trusted: user.trusted,
    },
    qq: info?.qq ?? "",
    nickname: info?.nickname ?? "",
    mouse: info?.mouse ?? "",
    pad: info?.pad ?? "",
    interest: info?.interest ?? "",
    loginTimes: N(stat?.loginTimes),
    loginIp: stat?.loginIp ?? "",
    registerIp: user.registerIp,
    lastLoginIp: user.lastLoginIp,
    clicks,
    newsCount,
    commentCount,
    bbsCount,
    postTotal,
    messageCount,
    /* 反作弊标记时效在数据层算好（RSC 渲染期禁 Date.now()） */
    lowTrustFlagged: N(user.lowTrustUntil) > Math.floor(Date.now() / 1000),
    rankBanned: N(user.rankBanUntil) > Math.floor(Date.now() / 1000),
    rankBanUntil: N(user.rankBanUntil),
    /* G1 排名行为审计：累计盲区率/旗精度展示，极端值判定口径见私有 core */
    rankedAudit: await (async () => {
      const s = await prisma.rankedAuditStat.findUnique({ where: { user: uid } });
      if (!s) return null;
      /* 判定口径已私有化（src/core/src/lib/admin-audit-secret.ts），主仓只展示 */
      const { summarizeRankedAudit } = await import("@/core/src/lib/admin-audit-secret");
      return summarizeRankedAudit({ games: s.games, clicks: s.clicks, blindClicks: s.blindClicks, flags: s.flags, blindFlags: s.blindFlags });
    })(),
    sumRank: sumTime ? N(rankRows[0]?.c) + 1 : 0,
    ranks: { beg: begRank, int: intRank, exp: expRank },
    recentVideos: videos.map((v) => ({
      id: N(v.id),
      level: v.level,
      status: v.status,
      createTime: N(v.createTime),
      realTime: infoMap.get(N(v.id))?.realTime ?? 0,
      board3bv: infoMap.get(N(v.id))?.board3bv ?? 0,
    })),
    oauth: oauth.map((o) => ({ provider: o.provider, nickname: o.nickname, createTime: N(o.createTime) })),
    recentLogs: logs.map((l) => ({ action: l.action, detail: l.detail, createTime: N(l.createTime), user: N(l.user) })),
  };
}

// ---------- 防小号：同 IP 账号组（2026-10-19） ----------
//
// 口径：
// · 维度二选一：最近登录 IP（user.last_login_ip，新站登录实时刷新，存量账号随登录逐步积累——默认）
//   或注册 IP（user.register_ip，2026-10-19 起新注册才有）。
// · IP 关联只做人工参考，处置永远人工决定；学校机房/网吧/家庭同 IP 属正常现象。
// · IP 归属地暂未接入（可选 ip2region 离线库），表中不展示归属地列。

export type IpDim = "login" | "register";

const IP_COL: Record<IpDim, string> = { login: "u.last_login_ip", register: "u.register_ip" };

export interface IpGroupRow {
  ip: string;
  count: number;
  unranked: number;
  today: number;
  firstReg: number;
  lastReg: number;
}

export interface IpGroupMember {
  id: number;
  chineseName: string;
  englishName: string;
  username: string;
  status: number;
  createTime: number;
  lastLoginTime: number;
  ranked: boolean;
}

export interface IpGroupStats {
  /** 今日新注册账号数 */
  todayNew: number;
  /** 今日新注册 IP 数（注册 IP 去重） */
  todayIps: number;
  /** 最近登录 IP 维度下 ≥2 / ≥5 个账号的组数 */
  groups2: number;
  groups5: number;
  /** 最大组账号数 */
  maxGroup: number;
}

export interface IpGroupsResult {
  rows: { group: IpGroupRow; members: IpGroupMember[] }[];
  total: number;
  pageSize: number;
  page: number;
  stats: IpGroupStats;
  /** q 精确命中某 IP 时为 true：组员全量展开 */
  expanded: boolean;
}

export async function getIpGroups(opts: {
  dim?: string;
  min?: string;
  q?: string;
  onlyUnranked?: string;
  page?: number;
}): Promise<IpGroupsResult> {
  const dim: IpDim = opts.dim === "register" ? "register" : "login";
  const col = IP_COL[dim];
  const min = [2, 3, 5].includes(parseInt(opts.min ?? "", 10)) ? parseInt(opts.min ?? "2", 10) : 2;
  const page = Math.max(1, opts.page ?? 1);
  // 精确查询仅接受 IPv4 形态，杜绝拼接风险（虽然始终走 ? 占位）
  const q = opts.q?.trim() ?? "";
  const exact = /^\d{1,3}(\.\d{1,3}){3}$/.test(q) ? q : "";
  const onlyUnranked = opts.onlyUnranked === "1";

  const todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  const conds = [`${col} <> ''`];
  const params: unknown[] = [];
  if (exact) {
    conds.push(`${col} = ?`);
    params.push(exact);
  }
  const where = `WHERE ${conds.join(" AND ")}`;
  // HAVING：最少账号数；「只看全部无成绩的组」→ c = unranked
  const having = [`c >= ?`];
  const havingParams: unknown[] = [min];
  if (onlyUnranked) having.push(`c = unranked`);

  const groupSelect = `SELECT ${col} ip, COUNT(*) c,
      SUM(CASE WHEN s.sum_time IS NULL OR s.sum_time = 0 THEN 1 ELSE 0 END) unranked,
      SUM(CASE WHEN u.create_time >= ? THEN 1 ELSE 0 END) today,
      MIN(u.create_time) first_reg, MAX(u.create_time) last_reg
    FROM \`user\` u LEFT JOIN user_scores s ON s.id = u.id
    ${where}
    GROUP BY ${col} HAVING ${having.join(" AND ")}`;

  const [groupRows, countRows, statsRows] = await Promise.all([
    prisma.$queryRawUnsafe<{
      ip: string;
      c: bigint;
      unranked: bigint;
      today: bigint;
      first_reg: bigint;
      last_reg: bigint;
    }[]>(
      `${groupSelect} ORDER BY c DESC, last_reg DESC LIMIT ? OFFSET ?`,
      todayStart,
      ...params,
      ...havingParams,
      ADMIN_PAGESIZE,
      (page - 1) * ADMIN_PAGESIZE
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM (${groupSelect}) t`,
      todayStart,
      ...params,
      ...havingParams
    ),
    prisma.$queryRawUnsafe<{
      today_new: bigint;
      today_ips: bigint;
      groups2: bigint;
      groups5: bigint;
      max_group: bigint;
    }[]>(
      `SELECT
        (SELECT COUNT(*) FROM \`user\` WHERE create_time >= ?) today_new,
        (SELECT COUNT(DISTINCT register_ip) FROM \`user\` WHERE register_ip <> '' AND create_time >= ?) today_ips,
        (SELECT COALESCE(COUNT(*), 0) FROM (SELECT last_login_ip FROM \`user\` WHERE last_login_ip <> '' GROUP BY last_login_ip HAVING COUNT(*) >= 2) t) groups2,
        (SELECT COALESCE(COUNT(*), 0) FROM (SELECT last_login_ip FROM \`user\` WHERE last_login_ip <> '' GROUP BY last_login_ip HAVING COUNT(*) >= 5) t) groups5,
        (SELECT COALESCE(MAX(c), 0) FROM (SELECT last_login_ip, COUNT(*) c FROM \`user\` WHERE last_login_ip <> '' GROUP BY last_login_ip) t) max_group`,
      todayStart,
      todayStart
    ),
  ]);

  const s = statsRows[0] ?? {};
  const stats: IpGroupStats = {
    todayNew: N(s.today_new),
    todayIps: N(s.today_ips),
    groups2: N(s.groups2),
    groups5: N(s.groups5),
    maxGroup: N(s.max_group),
  };

  const groups: IpGroupRow[] = groupRows.map((r) => ({
    ip: String(r.ip),
    count: N(r.c),
    unranked: N(r.unranked),
    today: N(r.today),
    firstReg: N(r.first_reg),
    lastReg: N(r.last_reg),
  }));

  // 第二轮：把本页各组的成员一次取回（组员可能跨页重复出现于不同组？不会——按 IP 分组互斥）
  const ips = groups.map((g) => g.ip);
  const membersByIp = new Map<string, IpGroupMember[]>();
  if (ips.length) {
    const memberRows = await prisma.$queryRawUnsafe<{
      id: bigint;
      chinese_name: string;
      english_name: string;
      create_time: bigint;
      last_login_time: bigint;
      status: number;
      ip: string;
      username: string | null;
      ranked: number | boolean;
    }[]>(
      `SELECT u.id, u.chinese_name, u.english_name, u.create_time, u.last_login_time, u.status,
              u.${dim === "login" ? "last_login_ip" : "register_ip"} ip, a.username,
              (s.sum_time IS NOT NULL AND s.sum_time > 0) ranked
        FROM \`user\` u
        LEFT JOIN user_auth a ON a.id = u.id
        LEFT JOIN user_scores s ON s.id = u.id
        WHERE u.${dim === "login" ? "last_login_ip" : "register_ip"} IN (${ips.map(() => "?").join(",")})
        ORDER BY u.create_time ASC, u.id ASC`,
      ...ips
    );
    for (const r of memberRows) {
      const ip = String(r.ip);
      const list = membersByIp.get(ip) ?? [];
      list.push({
        id: N(r.id),
        chineseName: String(r.chinese_name ?? ""),
        englishName: String(r.english_name ?? ""),
        username: String(r.username ?? ""),
        status: N(r.status),
        createTime: N(r.create_time),
        lastLoginTime: N(r.last_login_time),
        ranked: Number(r.ranked) === 1,
      });
      membersByIp.set(ip, list);
    }
  }

  return {
    rows: groups.map((g) => ({ group: g, members: membersByIp.get(g.ip) ?? [] })),
    total: N(countRows[0]?.c),
    pageSize: ADMIN_PAGESIZE,
    page,
    stats,
    expanded: Boolean(exact),
  };
}

// ---------- 录像 ----------

export interface AdminVideoRow {
  id: number;
  user: number;
  author: UserBrief | null;
  level: string;
  status: number;
  noflag: boolean;
  board3bv: number;
  realTime: number;
  software: string;
  version: string;
  hash: string;
  createTime: number;
  reviewUser: number | null;
  reviewer: UserBrief | null;
  reviewTime: number | null;
  clicks: number;
  downloads: number;
  /** 管理员已看过（后台播放器或下载任一，防盲审口径同 reviewVideo） */
  watched: boolean;
  comments: number;
  /** 是否有解析信息（false = 上传中断/解析失败） */
  hasInfo: boolean;
  /** 自动分拣（2026-10-19 方案 v2）：-1 未分拣 / 0 需核定 / 1 免核定 / 2 失败 */
  autoFlag: number;
  /** 触发原因位码（仅后台展示） */
  autoReason: number;
  /** STNB（video_metrics，缺行=null，需核定行展示用） */
  stnb: number | null;
  /** 手速 cls（次/秒，触发 cls 线的行展示具体值用） */
  cls: number | null;
  /** 总点击 cl（触发点击数下限的行展示具体值用） */
  cl: number | null;
  /** press-release 平均时长 ms（需核定行现算：左键优先、右键单独；null=未算/不适用） */
  pressAvgMs: number | null;
  /** 录像文件路径（/2026/01/05/xxx.mvf；后台播放器 fetch 用） */
  filepath: string;
}

const VIDEO_ORDERS: Record<string, string> = {
  new: "v.id DESC",
  old: "v.id ASC",
  time: "vi.real_time ASC",
  board: "vi.board_3bv DESC",
  click: "t.clicks DESC",
};

export interface VideoFilter {
  level?: string;
  status?: string;
  nf?: string;
  q?: string;
  from?: string;
  to?: string;
  order?: string;
  page?: number;
  /** 分拣池（2026-10-19）：exempt=免核定 / need=需核定；缺省=全部 */
  pool?: string;
}

function videoWhere(f: VideoFilter): {
  sql: string;
  params: unknown[];
  /** 过滤条件是否引用了 vi./u./t. 列（false = 仅 video 单表）——COUNT 短路判据 */
  joinsNeeded: boolean;
} {
  const conds: string[] = [];
  const params: unknown[] = [];
  // 过滤条件是否引用了 vi./u. 列（false = 仅 video 单表）——COUNT 短路判据。
  // 新增引用别表列的条件时必须同步置 true，否则 COUNT 会丢过滤。
  let joinsNeeded = false;
  if (f.level && ["beg", "int", "exp"].includes(f.level)) {
    conds.push("v.level = ?");
    params.push(f.level);
  }
  if (f.status && ["0", "10", "20"].includes(f.status)) {
    conds.push("v.status = ?");
    params.push(parseInt(f.status, 10));
  }
  // 分拣池筛选：需核定含未分拣(-1)/失败(2)（保守一律人工）；免核定只认 1
  if (f.pool === "exempt") conds.push("v.auto_flag = 1");
  if (f.pool === "need") conds.push("(v.auto_flag = 0 OR v.auto_flag = 2 OR v.auto_flag = -1)");
  if (f.nf === "1") {
    conds.push("vi.noflag = 1");
    joinsNeeded = true;
  }
  if (f.nf === "0") {
    conds.push("vi.noflag = 0");
    joinsNeeded = true;
  }
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) {
      conds.push("(v.id = ? OR v.user = ?)");
      params.push(BigInt(q), BigInt(q));
    } else {
      conds.push("u.chinese_name LIKE ?");
      params.push(`%${q}%`);
      joinsNeeded = true;
    }
  }
  // 日期（本地日边界）
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) {
    conds.push("v.create_time >= ?");
    params.push(Math.floor(new Date(`${f.from}T00:00:00`).getTime() / 1000));
  }
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) {
    conds.push("v.create_time < ?");
    params.push(Math.floor(new Date(`${f.to}T00:00:00`).getTime() / 1000) + 86400);
  }
  return { sql: conds.length ? "WHERE " + conds.join(" AND ") : "", params, joinsNeeded };
}

const VIDEO_FROM = `FROM video v
  LEFT JOIN video_info vi ON vi.id = v.id
  LEFT JOIN user u ON u.id = v.user
  LEFT JOIN video_stat t ON t.id = v.id`;

export async function getVideoListAdmin(
  f: VideoFilter
): Promise<{ rows: AdminVideoRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const { sql, params, joinsNeeded } = videoWhere(f);
  const order = VIDEO_ORDERS[f.order ?? "new"] ?? VIDEO_ORDERS.new;

  const [ids, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT v.id ${VIDEO_FROM} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      ADMIN_PAGESIZE,
      (page - 1) * ADMIN_PAGESIZE
    ),
    // 2026-10-23 慢 SQL 巡检：无过滤时三个 LEFT JOIN 均到主键不改变行数，
    // 短路成单表 COUNT（原四表 JOIN 全扫 2.5s/次，生产 10 次/日）。
    // 2026-10-25 巡检扩展：带过滤但过滤条件仅涉 video 单表（level/status/pool/
    // 数字 q/from/to）时同样短路——LEFT JOIN 到主键不改变行数，四表形态纯属
    // 扫描放大（生产实测 status=20 筛选 3.66s × rowsExam 123.6 万 → 单表亚秒）
    sql && !joinsNeeded
      ? prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c FROM video v ${sql}`, ...params)
      : sql
        ? prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c ${VIDEO_FROM} ${sql}`, ...params)
        : prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c FROM video v`),
  ]);

  const rows = await fillVideos(ids.map((r) => N(r.id)));
  return { rows, total: N(countRows[0]?.c), pageSize: ADMIN_PAGESIZE, page };
}

/** 待审分拣池计数（2026-10-21 默认落点用）：exempt=免核定 / need=需核定（含未分拣/失败）。
 *  只碰 video 单表 status+auto_flag（(status, level, review_time) 索引前缀可用），无 JOIN。 */
export async function getPoolCounts(): Promise<{ exempt: number; need: number }> {
  const rows = await prisma.$queryRawUnsafe<{ flag: number; c: bigint }[]>(
    `SELECT auto_flag flag, COUNT(*) c FROM video WHERE status = ? GROUP BY auto_flag`,
    VIDEO_STATUS.NORMAL
  );
  let exempt = 0;
  let need = 0;
  for (const r of rows) {
    if (r.flag === 1) exempt += N(r.c);
    else need += N(r.c); // 0/2/-1 全归需核定（保守人工），与 videoWhere 的 pool 口径一致
  }
  return { exempt, need };
}

/** 按 id 批量补齐录像行（保持传入顺序，缺 video_info 的照样列出并标记） */
export async function fillVideos(ids: number[]): Promise<AdminVideoRow[]> {
  if (!ids.length) return [];
  const bigIds = ids.map(BigInt);
  const [videos, infos, stats, metrics] = await Promise.all([
    prisma.video.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoInfo.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoStat.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoMetrics.findMany({
      where: { id: { in: bigIds } },
      select: { id: true, stnb: true, cls: true, cl: true },
    }),
  ]);
  const authors = await usersByIds(videos.map((v) => N(v.user)));
  const reviewers = await usersByIds([...new Set(videos.map((v) => N(v.reviewUser)))].filter((x) => x > 0));
  const vMap = new Map(videos.map((v) => [N(v.id), v]));
  const iMap = new Map(infos.map((i) => [N(i.id), i]));
  const sMap = new Map(stats.map((s) => [N(s.id), s]));
  const mMap = new Map(metrics.map((m) => [N(m.id), m]));

  const out: AdminVideoRow[] = [];
  for (const id of ids) {
    const v = vMap.get(id);
    if (!v) continue;
    const info = iMap.get(id);
    const st = sMap.get(id);
    out.push({
      id,
      user: N(v.user),
      author: authors.get(N(v.user)) ?? null,
      level: v.level,
      status: v.status,
      noflag: info?.noflag ?? false,
      board3bv: info?.board3bv ?? 0,
      realTime: info?.realTime ?? 0,
      software: info?.software ?? "",
      version: info?.version ?? "",
      hash: v.hash,
      createTime: N(v.createTime),
      reviewUser: v.reviewUser == null ? null : N(v.reviewUser),
      reviewer: reviewers.get(N(v.reviewUser)) ?? null,
      reviewTime: v.reviewTime == null ? null : N(v.reviewTime),
      clicks: st?.clicks ?? 0,
      downloads: st?.downloads ?? 0,
      watched: (st?.downloads ?? 0) > 0 || st?.adminWatched === 1,
      comments: st?.comments ?? 0,
      hasInfo: Boolean(info),
      autoFlag: v.autoFlag,
      autoReason: v.autoReason,
      stnb: mMap.get(id)?.stnb ?? null,
      cls: mMap.get(id)?.cls ?? null,
      cl: mMap.get(id)?.cl ?? null,
      pressAvgMs: null,
      filepath: info?.filepath ?? "",
    });
  }
  // 需核定行现算 press-release 平均时长（触发原因展示具体数值；每页 ≤25 行 × ~3ms）
  const needIds = out.filter((r) => r.autoFlag !== 1 && r.hasInfo).map((r) => r.id);
  if (needIds.length) {
    const pressMap = await computePressAvg(needIds);
    for (const r of out) {
      if (r.autoFlag !== 1) r.pressAvgMs = pressMap.get(r.id) ?? null;
    }
  }
  return out;
}

/** 现读录像文件算 press-release 平均时长（复用 video-triage 同口径；文件缺失/解析失败返回 null） */
async function computePressAvg(ids: number[]): Promise<Map<number, number | null>> {
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: ids.map(BigInt) } },
    select: { id: true, filepath: true },
  });
  const { readFileSync } = await import("fs");
  const pathMod = await import("path");
  const { parseVideoBinary } = await import("@/lib/videoradar");
  const { pressPairStats } = await import("@/lib/video-triage");
  const { PRESS_AVG_MS } = await import("@/lib/video-triage-limits");
  const result = new Map<number, number | null>();
  for (const info of infos) {
    result.set(N(info.id), null);
    try {
      const root = pathMod.join(process.cwd(), "videos");
      const full = pathMod.resolve(root, "." + info.filepath);
      if (!full.startsWith(root + pathMod.sep)) continue;
      const buf = new Uint8Array(readFileSync(full));
      const ext = info.filepath.split(".").pop()?.toLowerCase() ?? "";
      const parsed = parseVideoBinary(buf, ext);
      if (!parsed) continue;
      const lv = await prisma.video.findUnique({
        where: { id: info.id },
        select: { level: true },
      });
      if (!lv) continue;
      const line = PRESS_AVG_MS[lv.level] ?? 60;
      const ps = pressPairStats(parsed);
      /* 与触发口径一致：独立判左右键（n≥30 且 ≤阈值）；
         标签数值取实际命中的那只键（2026-10-19 张老师报 87ms≤60ms 错位——
         命中在右键 49ms、显示却取了左键 87ms）；两键都中取更低者 */
      let hit: number | null = null;
      if (ps.leftAvg !== null && ps.leftN >= 30 && ps.leftAvg <= line) hit = Math.round(ps.leftAvg);
      if (ps.rightAvg !== null && ps.rightN >= 30 && ps.rightAvg <= line) {
        const r = Math.round(ps.rightAvg);
        hit = hit === null ? r : Math.min(hit, r);
      }
      result.set(N(info.id), hit);
    } catch {
      /* 单行失败保持 null，标签退化为无数值形态 */
    }
  }
  return result;
}

// ---------- 评论 ----------

export interface AdminCommentRow {
  id: number;
  user: number;
  author: UserBrief | null;
  video: number;
  videoLevel: string;
  videoUser: number;
  content: string;
  status: number;
  /** AI 判可疑时的判定摘要（`类别：理由`），仅待审行有值（2026-10-13） */
  aiReason: string | null;
  createTime: number;
}

export async function getCommentListAdmin(f: {
  q?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: AdminCommentRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.status === "1") where.status = -1;
  else if (f.status === "0") where.status = 0;
  else if (f.status === "5") where.status = 5; // AI 待审（2026-10-13）
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }, { video: BigInt(q) }];
    else where.content = { contains: q };
  }

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.comment.count({ where }),
  ]);

  const authors = await usersByIds(comments.map((c) => N(c.user)));
  const vids = [...new Set(comments.map((c) => N(c.video)))];
  const videos = vids.length
    ? await prisma.video.findMany({ where: { id: { in: vids.map(BigInt) } }, select: { id: true, level: true, user: true } })
    : [];
  const vMap = new Map(videos.map((v) => [N(v.id), v]));

  return {
    rows: comments.map((c) => ({
      id: N(c.id),
      user: N(c.user),
      author: authors.get(N(c.user)) ?? null,
      video: N(c.video),
      videoLevel: vMap.get(N(c.video))?.level ?? "",
      videoUser: N(vMap.get(N(c.video))?.user),
      content: c.content ?? "",
      status: c.status,
      aiReason: c.aiReason ?? null,
      createTime: N(c.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 论坛 ----------

export interface AdminPostRow {
  id: number;
  board: number;
  boardName: string;
  user: number;
  author: UserBrief | null;
  title: string;
  replies: number;
  clicks: number;
  isPinned: boolean;
  isNice: boolean;
  isLocked: boolean;
  status: number;
  /** AI 判可疑时的判定摘要（`类别：理由`），仅待审行有值（2026-10-13） */
  aiReason: string | null;
  lastReplyTime: number;
  createTime: number;
}

export async function getPostListAdmin(f: {
  board?: string;
  q?: string;
  flag?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: AdminPostRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.board && /^\d+$/.test(f.board)) where.board = parseInt(f.board, 10);
  if (f.status === "1") where.status = -1;
  else if (f.status === "0") where.status = 0;
  else if (f.status === "5") where.status = 5; // AI 待审（2026-10-13）
  if (f.flag === "pinned") where.isPinned = true;
  if (f.flag === "nice") where.isNice = true;
  if (f.flag === "locked") where.isLocked = true;
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }];
    else where.OR = [{ title: { contains: q } }, { content: { contains: q } }];
  }

  const [posts, total] = await Promise.all([
    prisma.bbsPost.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
      select: {
        id: true, board: true, user: true, title: true, replies: true, clicks: true,
        isPinned: true, isNice: true, isLocked: true, status: true, aiReason: true,
        lastReplyTime: true, createTime: true,
      },
    }),
    prisma.bbsPost.count({ where }),
  ]);
  const authors = await usersByIds(posts.map((p) => N(p.user)));

  return {
    rows: posts.map((p) => ({
      id: N(p.id),
      board: p.board,
      boardName: BBS_BOARD_NAMES[p.board] ?? String(p.board),
      user: N(p.user),
      author: authors.get(N(p.user)) ?? null,
      // 老 ASP 实体出口统一解码（2026-10-15，同前台 getPostList 口径）
      title: decodeLegacyEntities(p.title),
      replies: p.replies,
      clicks: p.clicks,
      isPinned: p.isPinned,
      isNice: p.isNice,
      isLocked: p.isLocked,
      status: p.status,
      aiReason: p.aiReason ?? null,
      lastReplyTime: N(p.lastReplyTime),
      createTime: N(p.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 论坛待审混合队列（2026-10-27 张老师要求：主题 + 回复合并一处人审） ----------

export interface AdminBbsPendingRow {
  /** 主题 id（两种行都带：主题行=自身，回复行=所属主题，点进前台/下钻用） */
  postId: number;
  /** 回复 id（0 = 这是一条主题） */
  replyId: number;
  user: number;
  author: UserBrief | null;
  /** 主题标题 / 回复内容 UBB 渲染 */
  html: string;
  aiReason: string | null;
  createTime: number;
}

/** 待审（status=5）主题 + 回复合并列表，按时间倒序（新疑点排前）。无待审返回空数组。 */
export async function getPendingBbsAdmin(limit = 50): Promise<AdminBbsPendingRow[]> {
  const [posts, replies] = await Promise.all([
    prisma.bbsPost.findMany({
      where: { status: 5 },
      orderBy: { id: "desc" },
      take: limit,
      select: { id: true, user: true, title: true, aiReason: true, createTime: true },
    }),
    prisma.bbsReply.findMany({
      where: { status: 5 },
      orderBy: { id: "desc" },
      take: limit,
      select: { id: true, post: true, user: true, content: true, aiReason: true, createTime: true },
    }),
  ]);
  const authors = await usersByIds([
    ...new Set([...posts, ...replies].map((r) => N(r.user))),
  ]);
  const rows: AdminBbsPendingRow[] = [
    ...posts.map((p) => ({
      postId: N(p.id),
      replyId: 0,
      user: N(p.user),
      author: authors.get(N(p.user)) ?? null,
      html: `【主题】${decodeLegacyEntities(p.title)}`,
      aiReason: p.aiReason ?? null,
      createTime: N(p.createTime),
    })),
    ...replies.map((r) => ({
      postId: N(r.post),
      replyId: N(r.id),
      user: N(r.user),
      author: authors.get(N(r.user)) ?? null,
      html: ubb(r.content ?? ""),
      aiReason: r.aiReason ?? null,
      createTime: N(r.createTime),
    })),
  ];
  return rows.sort((a, b) => b.createTime - a.createTime).slice(0, limit);
}

export interface AdminReplyRow {
  id: number;
  post: number;
  user: number;
  author: UserBrief | null;
  content: string;
  status: number;
  /** AI 判可疑时的判定摘要（`类别：理由`），仅待审行有值（2026-10-13） */
  aiReason: string | null;
  createTime: number;
}

export async function getReplyListAdmin(postId: number): Promise<{
  post: { id: number; title: string; board: number } | null;
  rows: AdminReplyRow[];
}> {
  const post = await prisma.bbsPost.findUnique({
    where: { id: BigInt(postId) },
    select: { id: true, title: true, board: true },
  });
  if (!post) return { post: null, rows: [] };
  const replies = await prisma.bbsReply.findMany({ where: { post: post.id }, orderBy: { id: "asc" }, take: 200 });
  const authors = await usersByIds(replies.map((r) => N(r.user)));
  return {
    post: { id: N(post.id), title: decodeLegacyEntities(post.title), board: post.board },
    rows: replies.map((r) => ({
      id: N(r.id),
      post: N(r.post),
      user: N(r.user),
      author: authors.get(N(r.user)) ?? null,
      content: ubb(r.content ?? ""),
      status: r.status,
      aiReason: r.aiReason ?? null,
      createTime: N(r.createTime),
    })),
  };
}

// ---------- 每日一星（2026-10-27 后台历史页） ----------

export interface AdminStarRow {
  id: number;
  date: string;
  user: number;
  author: UserBrief | null;
  /** 当选感言（空串=未写/被删；speechDel>0 时可能被删过） */
  speech: string;
  /** 感言被管理员删除次数（≥2=本人永久不能再发） */
  speechDel: number;
  /** 感言赞/踩计数（2026-10-27 上线起记录；此前恒 0） */
  speechUp: number;
  speechDown: number;
  createTime: number;
}

/** 后台每日一星历史列表：按日期倒序分页，q 支持玩家 ID/名字前缀过滤 */
export async function getStarListAdmin(f: {
  q?: string;
  page?: number;
}): Promise<{ rows: AdminStarRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const q = (f.q ?? "").trim();

  // 玩家名前缀 → 先查 user 表拿 id 集（star 行数少，in 过滤足够；数字按 id/user 精确匹配）
  let userFilter: number[] | null = null;
  let userExact = 0;
  if (q) {
    if (/^\d+$/.test(q)) {
      userExact = parseInt(q, 10);
    } else {
      const matched = await prisma.user.findMany({
        where: { chineseName: { startsWith: q } },
        select: { id: true },
        take: 200,
      });
      userFilter = matched.map((u) => N(u.id));
    }
  }

  const where: Record<string, unknown> = {};
  if (userExact) where.user = BigInt(userExact);
  else if (userFilter) {
    if (!userFilter.length) return { rows: [], total: 0, pageSize: ADMIN_PAGESIZE, page };
    where.user = { in: userFilter.map((id) => BigInt(id)) };
  }

  const [stars, total] = await Promise.all([
    prisma.star.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.star.count({ where }),
  ]);
  const authors = await usersByIds(stars.map((s) => N(s.user)));

  return {
    rows: stars.map((s) => ({
      id: N(s.id),
      date: s.date,
      user: N(s.user),
      author: authors.get(N(s.user)) ?? null,
      speech: s.speech,
      speechDel: s.speechDel,
      speechUp: s.speechUp,
      speechDown: s.speechDown,
      createTime: N(s.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 动态 ----------

export interface AdminNewsRow {
  id: number;
  type: number;
  user: number;
  author: UserBrief | null;
  /** 发布时刻高级成绩快照（毫秒，0=无；2026-10-17 称号快照制，原 user_score 已删） */
  expTime: number;
  /** 发布时是否在榜（快照） */
  ranked: boolean;
  reference: number;
  detailsData: string;
  createTime: number;
}

export async function getNewsListAdmin(f: {
  type?: string;
  q?: string;
  page?: number;
}): Promise<{ rows: AdminNewsRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.type && /^\d+$/.test(f.type)) where.type = parseInt(f.type, 10);
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }, { reference: BigInt(q) }];
    else where.detailsData = { contains: q };
  }

  const [news, total] = await Promise.all([
    prisma.news.findMany({
      where,
      // 2026-10-20：动态流全站改 (create_time,id) 倒序（时间口径见 queries.getNews 注释）
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.news.count({ where }),
  ]);
  const authors = await usersByIds(news.map((n) => N(n.user)));

  return {
    rows: news.map((n) => ({
      id: N(n.id),
      type: n.type,
      user: N(n.user),
      author: authors.get(N(n.user)) ?? null,
      expTime: N(n.expTime),
      ranked: n.ranked === BigInt(1),
      reference: N(n.reference),
      detailsData: n.detailsData,
      createTime: N(n.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 操作日志 ----------

export interface AdminLogRow {
  id: number;
  user: number;
  author: UserBrief | null;
  action: string;
  target: string;
  targetId: number;
  detail: string;
  ip: string;
  createTime: number;
}

export async function getAdminLogs(f: {
  q?: string;
  action?: string;
  page?: number;
}): Promise<{ rows: AdminLogRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.action) where.action = f.action;
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ user: BigInt(q) }, { targetId: BigInt(q) }];
    else where.detail = { contains: q };
  }

  const [logs, total] = await Promise.all([
    prisma.adminLog.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.adminLog.count({ where }),
  ]);
  const authors = await usersByIds([...new Set(logs.map((l) => N(l.user)))]);

  return {
    rows: logs.map((l) => ({
      id: N(l.id),
      user: N(l.user),
      author: authors.get(N(l.user)) ?? null,
      action: l.action,
      target: l.target,
      targetId: N(l.targetId),
      detail: l.detail,
      ip: l.ip,
      createTime: N(l.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

/** 日志页动作下拉选项 */
export async function getLogActions(): Promise<{ action: string; count: number }[]> {
  const rows = await prisma.adminLog.groupBy({ by: ["action"], _count: { _all: true } });
  return rows.map((r) => ({ action: r.action, count: r._count._all })).sort((a, b) => b.count - a.count);
}

// ---------- 下拉选项数据 ----------

export async function getAreaOptions(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ area: string }[]>(
    `SELECT DISTINCT area FROM user WHERE area <> '' ORDER BY area`
  );
  return rows.map((r) => r.area);
}

// ---------- 首页信息流（仪表盘右侧栏） ----------

export async function getLatestUsers(limit = 8): Promise<AdminUserRow[]> {
  const users = await prisma.user.findMany({ orderBy: { id: "desc" }, take: limit });
  const ids = users.map((u) => u.id);
  const [auths, scores] = await Promise.all([
    prisma.userAuth.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, role: true } }),
    prisma.userScores.findMany({ where: { id: { in: ids } } }),
  ]);
  const aMap = new Map(auths.map((a) => [N(a.id), a]));
  const sMap = new Map(scores.map((s) => [N(s.id), s]));
  const king = await getThunderKingId(); // 2026-10-19 总司令=雷界第一人特判
  const rows: AdminUserRow[] = [];
  for (const u of users) {
    const id = N(u.id);
    const sumTime = N(sMap.get(id)?.sumTime);
    const expTime = N(sMap.get(id)?.expTime);
    rows.push({
      id,
      chineseName: u.chineseName,
      englishName: u.englishName,
      sex: u.sex,
      username: aMap.get(id)?.username ?? "",
      area: u.area,
      status: u.status,
      role: aMap.get(id)?.role ?? 0,
      createTime: N(u.createTime),
      lastLoginTime: N(u.lastLoginTime),
      banUntil: N(u.banUntil),
      rankBanUntil: N(u.rankBanUntil),
      lowTrustUntil: N(u.lowTrustUntil),
      title: await assessTitle(expTime, king > 0 && king === id),
      sumTime,
      videos: 0,
      trusted: u.trusted,
    });
  }
  return rows;
}

export async function getLatestVideosBrief(limit = 8): Promise<(AdminVideoRow & { authorName: string })[]> {
  const ids = await prisma.video.findMany({ orderBy: { id: "desc" }, take: limit, select: { id: true } });
  const rows = await fillVideos(ids.map((r) => N(r.id)));
  return rows.map((r) => ({ ...r, authorName: r.author?.chineseName ?? `#${r.user}` }));
}

// ---------- 站内信广播历史 ----------

export interface BroadcastRow {
  content: string;
  fromUser: number;
  author: UserBrief | null;
  receivers: number;
  readCount: number;
  createTime: number;
}

/** 广播历史：按「发送人 + 内容 + 时间」聚合成一次广播（逐条写入 message 表，故用聚合还原） */
export async function getBroadcastHistory(limit = 20): Promise<BroadcastRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    { content: string; from_user: bigint; c: bigint; read_c: bigint; t: bigint }[]
  >(
    `SELECT content, from_user, COUNT(*) c, SUM(is_read = 1) read_c, MIN(create_time) t
     FROM message WHERE is_system = 1
     GROUP BY content, from_user, create_time
     ORDER BY t DESC LIMIT ${limit}`
  );
  const authors = await usersByIds(rows.map((r) => N(r.from_user)));
  return rows.map((r) => ({
    content: r.content,
    fromUser: N(r.from_user),
    author: authors.get(N(r.from_user)) ?? null,
    receivers: N(r.c),
    readCount: N(r.read_c),
    createTime: N(r.t),
  }));
}

/** 站内信总览 */
export async function getMessageStats(): Promise<{ total: number; unread: number; system: number; today: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = BigInt(Math.floor(today.getTime() / 1000));
  const [total, unread, system, todayCount] = await Promise.all([
    prisma.message.count(),
    prisma.message.count({ where: { isRead: false } }),
    prisma.message.count({ where: { isSystem: true } }),
    prisma.message.count({ where: { createTime: { gte: since } } }),
  ]);
  return { total, unread, system, today: todayCount };
}

// （每日一星 getStarHistory 已于 2026-10-13 随功能下线移除）

/** 搜索玩家（后台通用）：按姓名 / 账号模糊匹配 */
export async function searchUsersBrief(q: string, limit = 10): Promise<{ id: number; name: string; username: string }[]> {
  const kw = q.trim();
  if (!kw) return [];
  const like = `%${kw}%`;
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; chinese_name: string; username: string }[]>(
    `SELECT u.id, u.chinese_name, COALESCE(a.username, '') username
     FROM user u LEFT JOIN user_auth a ON a.id = u.id
     WHERE u.chinese_name LIKE ? OR u.english_name LIKE ? OR a.username LIKE ?
     ORDER BY u.id DESC LIMIT ${limit}`,
    like,
    like,
    like
  );
  return rows.map((r) => ({ id: N(r.id), name: r.chinese_name, username: r.username }));
}

export { BBS_BOARDS, VIDEO_STATUS, type VideoLevel, type VideoLevel as VLevel };

// ---------- 头像审核（2026-09-24）----------

export interface AdminAvatarRow {
  id: number;
  user: number;
  author: UserBrief | null;
  /** 头像文件相对路径（/uploads/avatar/…） */
  filepath: string;
  status: number;
  /** AI 初审结论：pass = 判定合格，review = 存疑转人工 */
  verdict: string;
  /** AI 初审来源：ai / disabled / timeout / error（决定后台展示「AI 放行/存疑/超时/异常」） */
  source: string;
  /** AI 初审分类：ok / porn / politics / nonreal */
  category: string;
  reason: string;
  /** 上传前的头像值，管理员撤销自动放行时回滚用 */
  prevAvatar: string;
  reviewer: number;
  reviewerName: string;
  reviewTime: number;
  createTime: number;
}

/** 头像审核队列：待审按「最老在前」清理积压，已审按「最新在前」方便回溯 */
export async function getAvatarListAdmin(f: {
  status: number;
  page?: number;
}): Promise<{ rows: AdminAvatarRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where = { status: f.status };
  const [rows, total] = await Promise.all([
    prisma.avatarReview.findMany({
      where,
      orderBy: { id: f.status === AVATAR_REVIEW_STATUS.PENDING ? "asc" : "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.avatarReview.count({ where }),
  ]);

  const authors = await usersByIds(rows.map((r) => N(r.user)));
  const reviewerIds = [...new Set(rows.map((r) => N(r.reviewer)).filter((x) => x > 0))];
  const reviewers = await usersByIds(reviewerIds);

  return {
    rows: rows.map((r) => ({
      id: N(r.id),
      user: N(r.user),
      author: authors.get(N(r.user)) ?? null,
      filepath: r.filepath,
      status: r.status,
      verdict: r.verdict,
      source: r.source,
      category: r.category,
      reason: r.reason,
      prevAvatar: r.prevAvatar,
      reviewer: N(r.reviewer),
      reviewerName: N(r.reviewer) === 0 ? "" : (reviewers.get(N(r.reviewer))?.chineseName ?? ""),
      reviewTime: N(r.reviewTime),
      createTime: N(r.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

/** 待审头像数（侧栏红点角标） */
export async function getAvatarPendingCount(): Promise<number> {
  return prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.PENDING } });
}

/** 头像审核概览：各状态计数 + AI 拦截分类分布 */
export async function getAvatarStats(): Promise<{
  pending: number;
  approved: number;
  rejected: number;
  /** 其中由 AI 直接放行、无人工参与的 */
  autoApproved: number;
  /** AI 判为需要关注的分类计数（porn / politics / nonreal） */
  categoryCounts: { category: string; count: number }[];
}> {
  const [pending, approved, rejected, autoApproved, grouped] = await Promise.all([
    prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.PENDING } }),
    prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.APPROVED } }),
    prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.REJECTED } }),
    // 只统计「当前仍处于通过状态」的自动放行，被人工驳回的不算
    prisma.avatarReview.count({
      where: { status: AVATAR_REVIEW_STATUS.APPROVED, reviewer: BigInt(0) },
    }),
    prisma.avatarReview.groupBy({
      by: ["category"],
      where: { category: { notIn: ["", "ok"] } },
      _count: { _all: true },
    }),
  ]);
  return {
    pending,
    approved,
    rejected,
    autoApproved,
    categoryCounts: grouped.map((g) => ({ category: g.category, count: g._count._all })),
  };
}
