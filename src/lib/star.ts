// 人气（Click）——移植 2008 ASP 版 Click 表逻辑
// 每日一星 2026-10-13 下线，2026-10-25 张老师定新版评选口径恢复（见文末每日一星段）。
//
// 2026-10-14 口径修正（方案 B，张老师定）：
//   人气总数改以 user_stat.clicks 为准——它是旧站 Player.Player_Click 累计值的同步镜像，
//   含 2017 年 Click 表重建前的早期历史（旧站 Click 明细最早仅到 2017-02-07）。
//   此前误用 click 明细表 count，导致人气普遍显示为 0~个位数（明细里只有新站上线后的记录）。
//   click 明细表继续写入，职责降为「今日人气」统计 + 「同 IP 同日只计一次」的去重闸门。

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";
import { TITLE_THRESHOLDS } from "./config";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 人气 ----------

/** 人气来源标记（十五轮 2026-10-25 张老师定：每日一星/用户卡片/用户主页展示即计人气）。
 *  同一 IP 同一天对同一地盘只计一次（去重闸门不变），但**跨来源也去重**——
 *  ip 列拼来源标记（"1.2.3.4|home"），同一人当天看过用户主页再看每日一星不重复计。
 *  来源枚举：home=用户主页 / card=右栏用户卡片（BBS/录像详情页）/ star=首页每日一星 */
export type ClickSource = "home" | "card" | "star";

/** 看地盘计人气（同一 IP 同一天对同一地盘只计一次）
 *  明细插入成功才累计总数 +1：同一事务，唯一键冲突则整体回滚（= 今天已计过）。 */
export async function recordClick(userId: number, ip: string, source: ClickSource = "home"): Promise<void> {
  if (!ip) return;
  const now = nowSec();
  const id = BigInt(userId);
  try {
    await prisma.$transaction([
      prisma.click.create({
        data: { user: id, ip: `${ip}|${source}`, date: todayStr(), createTime: now, updateTime: now },
      }),
      prisma.userStat.upsert({
        where: { id },
        create: { id, clicks: 1 },
        update: { clicks: { increment: 1 } },
      }),
    ]);
  } catch {
    // 唯一键冲突 = 该 IP 今天已计过，忽略
  }
}

/** 地盘人气（总数 + 今日）
 *  总数 = user_stat.clicks（旧站累计镜像，含 2017 前历史）；今日 = click 明细当日条数 */
export async function getClicks(userId: number): Promise<{ total: number; today: number }> {
  const [stat, today] = await Promise.all([
    prisma.userStat.findUnique({ where: { id: BigInt(userId) }, select: { clicks: true } }),
    prisma.click.count({ where: { user: BigInt(userId), date: todayStr() } }),
  ]);
  return { total: stat?.clicks ?? 0, today };
}

// ---------- 每日一星（2026-10-25 张老师定新版口径） ----------
//
// 旧版（2008~2026-10）：神界全员 ∪ 近 30 天破纪录者，当月不复选。
// 新版（人神界体系已撤销）：候选池 =
//   ① 少将级（含）以上军衔——高级时间 exp_time ≤ SUB50 阈值（TITLE_THRESHOLDS 少将档），
//      现役（user.status=0），且近 30 天登录过（last_login_time，2026-10-26 张老师增列：
//      沉睡老将不参选，实测①路 221 → 70、总池 262 → 113）。总司令（雷界第一人）
//      必然 exp_time ≤ 50s，天然覆盖。
//   ② 非少将级玩家收紧条件（张老师 10-25 定）：30 日内打破过个人纪录 且 排名处于上升状态——
//      近 30 天有破纪录动态（news.type=20 PERSON_RECORD，与旧版口径同源）
//      且 rank_snapshot.delta > 0（30 天滚动窗口名次差，正=上升；每日 00:05 cron
//      预计算，与进步榜 /grow 同源）。两条件取交集：只破纪录但名次没涨 / 名次涨了
//      但靠别人掉出榜都不够，要「自己进步 + 名次兑现」。
//   ③ 头像不再硬性要求（十七轮 2026-10-25 改定）：有合法头像（新版上传 /uploads/avatar/、
//      OAuth 外链 http / 旧站照片标记 '1'）者的入袋份额 ×2——鼓励上传真人照片，
//      但不阻断无头像者参选。
//   两路分开计席（十八轮 2026-10-28 张老师定）：两路资格各自独立入袋、不再并集去重——
//   双命中（SUB50 有登录 且 有进步）席位叠加，有头像再整体翻倍。
//   ②路席位分级（十九轮 2026-10-28 张老师定：进步多少 + 排位高低都计入）：
//   席位 = 1 + 进步加成（delta≥200 +2 / delta≥50 +1）+ 排位加成（今日名次≤100 +2 / ≤500 +1），
//   进步得多 / 排位已高仍进步者席位更多，②路理论最高 5 席。
//   去掉近 30 日内已当选者，按日期哈希确定性随机抽一位。
//   旧版「当月不复选」收紧为「30 日不复选」——与候选资格的 30 天窗口同拍，
//   也避免月末/月初边界出现同月二次当选的观感问题。

import { publishNews } from "./news";
import { sendSystemMessage } from "./message";

export interface StarInfo {
  date: string;
  user: UserBrief | null;
  /** 当选感言（≤28 字；空串=未写或被管理员删除） */
  speech: string;
  /** 感言被管理员删除次数（≥2 = 本人永久不能再发；九轮张老师定） */
  speechDel: number;
  /** 感言赞/踩计数（2026-10-27 张老师定：登录用户可投，star_vote 明细按人硬去重） */
  speechUp: number;
  speechDown: number;
  /** 当前登录用户的已投票向（"up"/"down"/null 未投；SSR 带出，跨设备一致） */
  myVote: "up" | "down" | null;
}

/** 少将档高级时间上限（毫秒）——TITLES 序：总司令(特判), 大元帅 35000, 元帅 40000, 大将 42000,
 *  上将 45000, 中将 48000, 少将 50000。TITLE_THRESHOLDS[5] 恰为少将档（见 config.ts） */
const MAJOR_GENERAL_MS = TITLE_THRESHOLDS[5]; // 50000

/** 近 30 日已当选者 user id 集合（date > 今日-30 天，字符串日期比较） */
async function recentStarUserIds(today: string): Promise<Set<number>> {
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  const cutoffStr = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
  const rows = await prisma.star.findMany({
    where: { date: { gt: cutoffStr } },
    select: { user: true },
  });
  return new Set(rows.map((r) => N(r.user)));
}

/** 今日感言投票明细补充：SSR 带出「我投过什么」（跨设备一致；未登录/未投=null） */
async function getMyVote(date: string, viewerUid: number | null): Promise<"up" | "down" | null> {
  if (!viewerUid) return null;
  const v = await prisma.starVote.findUnique({
    where: { date_user: { date, user: BigInt(viewerUid) } },
    select: { dir: true },
  });
  return v ? (v.dir ? "up" : "down") : null;
}

/**
 * 取今日之星，没有则评选（并发安全：确定性哈希 + star.date 唯一键兜底）：
 * 候选 =（少将及以上现役 且 近 30 天登录过）∪（近 30 日破纪录 且 名次上升者），
 * 排除近 30 日已当选者；同一天多次请求结果一致（日期哈希），无候选返回 null。
 * viewerUid：当前登录用户（用于带出 myVote；可不传）。
 */
export async function getTodayStar(viewerUid?: number): Promise<StarInfo | null> {
  const today = todayStr();
  const existing = await prisma.star.findUnique({ where: { date: today } });
  if (existing) {
    const [authors, myVote] = await Promise.all([
      usersByIds([N(existing.user)]),
      getMyVote(today, viewerUid ?? null),
    ]);
    return {
      date: today,
      user: authors.get(N(existing.user)) ?? null,
      speech: existing.speech,
      speechDel: existing.speechDel,
      speechUp: existing.speechUp,
      speechDown: existing.speechDown,
      myVote,
    };
  }

  // 候选池两路分开计席（十八轮 2026-10-28 张老师定；十九轮同日加进步席位分级）：
  //   ① 少将及以上现役 且 30 天内登录过（2026-10-26 张老师增列 last_login_time 条件——
  //      沉睡老将不参选，只约束①路；②路破纪录本身即活跃证明，不另设登录门槛）。恒 1 席。
  //   ② 30 天内破纪录 ∧ 排名上升（delta>0）现役。席位 = 1 + 进步加成 + 排位加成（十九轮）：
  //      进步加成（delta = 30 天窗口名次差，封禁修正后）：delta≥200 → +2；delta≥50 → +1；
  //      排位加成（今日总计时间榜名次）：≤100 → +2（百强仍有进步）；≤500 → +1。
  //      进步得多 / 排位已高仍进步者，席位更多。理论最高 5 席。
  //   两路**分开计席**：两条都命中的用户席位叠加（不再 UNION 去重合一），
  //   再叠加头像加成——有头像者全部席位 ×2。
  // 封禁账号不入池（两路均 JOIN user.status=0；②路 rank_snapshot 残留 delta 的
  // 被封者一并滤掉，与 /grow 进步榜口径一致）。delta 本身已在快照刷新时做封禁修正
  // （ranksnap.ts：扣掉「别人被封白捡的名次」），delta>0 即真实名次上升。
  // 头像加成：有合法头像（/uploads/avatar/%、http 外链、旧站 '1'）者每份席位翻倍——
  // 鼓励上传真人照片，但不阻断无头像者参选。
  const rankPath = `$.\\"${today}\\"`; // rank_snapshot.ranks JSON 里今日名次的 key
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint; seats: number; hasAvatar: number }>>(
    `SELECT s.id, 1 AS seats, CASE WHEN u.avatar LIKE '/uploads/avatar/%' OR u.avatar LIKE 'http%' OR u.avatar = '1' THEN 1 ELSE 0 END AS hasAvatar
       FROM user_scores s
       JOIN \`user\` u ON u.id = s.id AND u.status = 0 AND u.last_login_time >= ?
       WHERE s.exp_time > 0 AND s.exp_time <= ?
     UNION ALL
     SELECT DISTINCT n.user,
            1 + CASE WHEN r.delta >= 200 THEN 2 WHEN r.delta >= 50 THEN 1 ELSE 0 END
              + CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(r.ranks, ?)) AS UNSIGNED) <= 100 THEN 2
                     WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(r.ranks, ?)) AS UNSIGNED) <= 500 THEN 1
                     ELSE 0 END AS seats,
            CASE WHEN u.avatar LIKE '/uploads/avatar/%' OR u.avatar LIKE 'http%' OR u.avatar = '1' THEN 1 ELSE 0 END
       FROM news n
       JOIN rank_snapshot r ON r.user = n.user AND r.delta > 0
       JOIN \`user\` u ON u.id = n.user AND u.status = 0
       WHERE n.type = 20 AND n.user > 0 AND n.create_time >= ?`,
    Math.floor(Date.now() / 1000) - 30 * 86400,
    MAJOR_GENERAL_MS,
    rankPath,
    rankPath,
    Math.floor(Date.now() / 1000) - 30 * 86400
  );
  const excluded = await recentStarUserIds(today);
  // 两路分开计席：同一用户席位跨路累加（UNION ALL 下①路一人一行恒 1 席，
  // ②路已按 DISTINCT 去重到一人一行、席位由 SQL 分级算出）
  const seen = new Map<number, { seats: number; hasAvatar: number }>();
  for (const r of rows) {
    const id = N(r.id);
    const cur = seen.get(id);
    if (cur) cur.seats += Number(r.seats);
    else seen.set(id, { seats: Number(r.seats), hasAvatar: Number(r.hasAvatar) });
  }
  const candidates = [...seen.entries()].filter(([id]) => !excluded.has(id));
  if (!candidates.length) return null;

  // 加权抽签袋（十七轮头像×2 + 十八轮两路分席 + 十九轮进步席位分级）：
  // 全部席位入袋一次，有头像再整体翻倍；②路单命中 1~5 份，双命中再叠加①路 1 份；
  // 日期哈希确定性随机（同一天多次请求结果一致，并发重复插入由唯一键兜底）
  const bag: number[] = [];
  for (const [id, { seats, hasAvatar }] of candidates) {
    for (let i = 0; i < seats; i++) bag.push(id);
    if (hasAvatar) {
      for (let i = 0; i < seats; i++) bag.push(id);
    }
  }
  let hash = 0;
  for (const ch of today) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const winner = bag[hash % bag.length];

  const now = nowSec();
  try {
    await prisma.star.create({
      data: { user: BigInt(winner), date: today, speech: "", createTime: now, updateTime: now },
    });
    // 当选动态（2026-10-25 张老师定）：金色「当选了每日一星！」——
    // 只在本次请求真正写入 star 行时发（并发败者/已有行重访不重复发）；
    // 快照口径走 publishNews 缺省（当前 exp_time + 在榜状态）
    await publishNews({ type: 54, userId: winner });
    // 当选系统私信（2026-10-25 八轮张老师定）：通知当选 + 引导首页发表感言。
    // 同样只在真正当选的请求发一次。
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p2 = (n: number) => (n < 10 ? "0" + n : String(n));
    const dateCn = `${d.getUTCFullYear()}年${p2(d.getUTCMonth() + 1)}月${p2(d.getUTCDate())}日`;
    await sendSystemMessage(
      winner,
      `恭喜您当选${dateCn}的每日一星，快去首页发表感言吧！`
    ).catch(() => undefined); // 短信失败不阻断评选
  } catch {
    // 并发下另一请求已写入，以其为准
  }
  const row = await prisma.star.findUnique({ where: { date: today } });
  if (!row) return null;
  const [authors, myVote] = await Promise.all([
    usersByIds([N(row.user)]),
    getMyVote(today, viewerUid ?? null),
  ]);
  return {
    date: today,
    user: authors.get(N(row.user)) ?? null,
    speech: row.speech,
    speechDel: row.speechDel,
    speechUp: row.speechUp,
    speechDown: row.speechDown,
    myVote,
  };
}

/** 感言字数上限（全角字计；十一轮张老师定 28 → 30） */
export const STAR_SPEECH_LIMIT = 30;

/**
 * 写当选感言（2026-10-25 八轮张老师定；九轮补删除重发规则；十一轮补内容闸门）：
 * 仅当日当选者本人可写；≤30 字；一次性——已发表不可修改；
 * 被管理员删除后可重发一次（speechDel<2），第二次被删后永久禁止。
 * 内容闸门（十一轮）：checkSensitive 前置 + 拒绝 HTML 标签（< >）与外链
 * 特征（http/https/www/.com 等）——防注入代码观感与广告导流；
 * 写后 AI 复审（判 review 视同删除但不计数）。
 */
export async function setStarSpeech(userId: number, speech: string): Promise<{ ok: boolean; error?: string; speech?: string }> {
  const today = todayStr();
  const row = await prisma.star.findUnique({ where: { date: today } });
  if (!row || N(row.user) !== userId) {
    return { ok: false, error: "只有今日每日一星可以发表感言" };
  }
  if (row.speech) {
    return { ok: false, error: "感言已发表，不能修改" };
  }
  if (row.speechDel >= 2) {
    return { ok: false, error: "感言已被删除两次，不能再发表" };
  }
  const text = speech.trim().slice(0, STAR_SPEECH_LIMIT);
  if (!text) return { ok: false, error: "感言不能为空" };
  // HTML / 外链闸门（十一轮）：感言是纯文本展示，含尖括号或链接特征直接拒绝
  if (/[<>]/.test(text)) {
    return { ok: false, error: "感言不能包含代码" };
  }
  if (/(https?:\/\/|www\.|\.com|\.cn|\.net)\b/i.test(text)) {
    return { ok: false, error: "感言不能包含链接" };
  }
  const { checkSensitive } = await import("./sensitive");
  if (!checkSensitive(text).ok) {
    return { ok: false, error: "感言包含敏感词，请修改后重试" };
  }
  const now = nowSec();
  await prisma.$transaction([
    prisma.star.update({
      where: { date: today },
      // 感言计数清零（2026-10-27）：被删后重发是新感言，旧赞/踩不结转
      data: { speech: text, speechUp: 0, speechDown: 0, updateTime: now },
    }),
    // 投票明细一并清空：重发的新感言可再投（旧票不占额）
    prisma.starVote.deleteMany({ where: { date: today } }),
  ]);
  return { ok: true, speech: text };
}

/**
 * 删除感言（九轮 2026-10-25 张老师定：管理员清理不当言论；十五轮补通知，十六轮定稿为系统消息）：
 * 仅管理员可调（route 层校验 role，此处只管数据）；speechDel+1、speech 清空；
 * 删两次后本人不能再发（setStarSpeech 校验 speechDel>=2）。
 * 十六轮：删除后发系统消息（is_system=1），文案带管理员名：
 * 「管理员xxx删除了你每日之星的感言，公开场合请注意措辞，合理发言」。
 */
export async function deleteStarSpeech(operatorId: number): Promise<void> {
  const today = todayStr();
  const row = await prisma.star.findUnique({ where: { date: today } });
  await prisma.$transaction([
    prisma.star.update({
      where: { date: today },
      // 感言计数清零（2026-10-27）：感言撤下即无投票对象，旧计数不残留
      data: { speech: "", speechDel: { increment: 1 }, speechUp: 0, speechDown: 0, updateTime: nowSec() },
    }),
    // 投票明细一并清空：感言已撤下，释放投票额（重发后可再投）
    prisma.starVote.deleteMany({ where: { date: today } }),
  ]);
  if (row && row.speech) {
    const { sendSystemMessage } = await import("./message");
    const op = await prisma.user.findUnique({
      where: { id: BigInt(operatorId) },
      select: { chineseName: true },
    });
    const opName = op?.chineseName || `用户${operatorId}`;
    await sendSystemMessage(
      N(row.user),
      `管理员${opName}删除了你每日之星的感言，公开场合请注意措辞，合理发言`
    ).catch(() => undefined); // 通知失败不阻断删除
  }
}

/**
 * 感言赞/踩（2026-10-27 张老师定；二轮收紧：仅登录用户，服务端按人硬去重）：
 * star_vote 明细同日同人只一行（唯一键 date+user 兜底并发），事务写明细 + 计数 +1；
 * 同一事务里明细插入冲突即回滚 = 已投过（error="已投过票"）。
 * 彻底堵隐身浏览器无限刷——去重不再依赖 localStorage。
 */
export async function voteStarSpeech(
  userId: number,
  dir: "up" | "down"
): Promise<{ ok: boolean; error?: string; up?: number; down?: number; myVote?: "up" | "down" }> {
  const today = todayStr();
  const star = await prisma.star.findUnique({ where: { date: today } });
  if (!star || !star.speech) {
    return { ok: false, error: "今日感言不存在" };
  }
  try {
    const now = nowSec();
    await prisma.$transaction([
      prisma.starVote.create({
        data: { date: today, user: BigInt(userId), dir: dir === "up", createTime: now },
      }),
      prisma.star.update({
        where: { date: today },
        data: dir === "up" ? { speechUp: { increment: 1 } } : { speechDown: { increment: 1 } },
      }),
    ]);
  } catch {
    // 唯一键冲突 = 该用户今天已投过（赞或踩二选一）
    return { ok: false, error: "今天已投过票了" };
  }
  const updated = await prisma.star.findUnique({
    where: { date: today },
    select: { speechUp: true, speechDown: true },
  });
  return { ok: true, up: updated?.speechUp ?? 0, down: updated?.speechDown ?? 0, myVote: dir };
}
