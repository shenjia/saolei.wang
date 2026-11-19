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
//   2026-11-02 张老师再定：在「30 天内当选过的不参选」后新增一条全局排除——
//   「7 日内未登录过的不参选」（last_login_time < 今日-7 天者滤掉）。
//   ①路原有 30 天登录条件之上再收紧到 7 天；②路此前以破纪录为活跃证明不设登录门槛，
//   现一并补上（沉睡者即使破纪录也不参选）。

import { publishNews } from "./news";
import { sendSystemMessage } from "./message";

export interface StarInfo {
  date: string;
  user: UserBrief | null;
  /** 当选感言（≤30 字；2026-11-11 预写制：来源 user.star_speech，空串=该用户未写或被管理员删除） */
  speech: string;
  /** 感言被管理员删除次数（原 star 行口径；后台历史展示用） */
  speechDel: number;
  /** 感言赞/踩计数（2026-10-27 张老师定：登录用户可投，star_vote 明细按人硬去重） */
  speechUp: number;
  speechDown: number;
  /** 当前登录用户的已投票向（"up"/"down"/null 未投；SSR 带出，跨设备一致） */
  myVote: "up" | "down" | null;
  /** 当前登录者自己预写的感言（2026-11-11 预写制；非空=已写过，图标转灰不可再点） */
  mySpeech: string;
  /** 当前登录者感言被删次数（≥2 = 永久不能再写，图标灰死） */
  mySpeechDel: number;
  /** 当前登录者是今日之星且当日已行使「再修改一次」（改完图标灰死；未行使则当选日常绿可改） */
  myEdited: boolean;
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

/** 7 日内登录过的 user id 集合过滤（2026-11-02 张老师定：7 日内未登录过的不参选） */
function isLoggedInWithin7Days(lastLoginTime: bigint | null): boolean {
  if (!lastLoginTime) return false; // 0=未记录，视同从未登录
  return lastLoginTime >= BigInt(Math.floor(Date.now() / 1000) - 7 * 86400);
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

/** 观看者自己的预写感言状态（2026-11-11 预写制；标题图标灰/绿态用；未登录给空态）。
 *  row 传当日 star 行（可空）：观看者恰为今日之星时带出当日是否已行使「再修改一次」 */
async function viewerSpeechState(
  viewerUid: number | undefined,
  row?: { user: bigint; speechEdited: boolean } | null
): Promise<{ mySpeech: string; mySpeechDel: number; myEdited: boolean }> {
  if (!viewerUid) return { mySpeech: "", mySpeechDel: 0, myEdited: false };
  const [u, edited] = await Promise.all([
    prisma.user.findUnique({
      where: { id: BigInt(viewerUid) },
      select: { starSpeech: true, starSpeechDel: true },
    }),
    (async () =>
      row && N(row.user) === viewerUid
        ? prisma.star.findUnique({ where: { date: todayStr() }, select: { speechEdited: true } })
        : null)(),
  ]);
  return {
    mySpeech: u?.starSpeech ?? "",
    mySpeechDel: u?.starSpeechDel ?? 0,
    myEdited: !!edited?.speechEdited,
  };
}

/** 指定用户是否已写过预写感言（2026-11-11 预写制；/message?speech=1 自动弹窗短路用） */
export async function hasStarSpeech(userId: number): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { starSpeech: true },
  });
  return !!u?.starSpeech;
}

/**
 * 取今日之星，没有则评选（并发安全：确定性哈希 + star.date 唯一键兜底）：
 * 候选 =（少将及以上现役 且 近 30 天登录过）∪（近 30 日破纪录 且 名次上升者），
 * 排除近 30 日已当选者与 7 日内未登录者（2026-11-02 张老师定）；同一天多次请求结果一致
 * （日期哈希），无候选返回 null。
 * viewerUid：当前登录用户（用于带出 myVote；可不传）。
 */
export async function getTodayStar(viewerUid?: number): Promise<StarInfo | null> {
  const today = todayStr();
  const existing = await prisma.star.findUnique({ where: { date: today } });
  if (existing) {
    // 预写制自愈（2026-11-11）：行 speech 为空时回读用户正本并镜像——
    // 覆盖「部署切换前创建的行没拷贝预写感言」的过渡态；
    // 管理员删除是两处同清，回读必为空串，不会复活已删感言
    let speech = existing.speech;
    if (!speech) {
      const su = await prisma.user.findUnique({
        where: { id: existing.user },
        select: { starSpeech: true },
      });
      if (su?.starSpeech) {
        speech = su.starSpeech;
        await prisma.star.update({ where: { date: today }, data: { speech, updateTime: nowSec() } });
      }
    }
    const [authors, myVote, vs] = await Promise.all([
      usersByIds([N(existing.user)]),
      getMyVote(today, viewerUid ?? null),
      viewerSpeechState(viewerUid, existing),
    ]);
    return {
      date: today,
      user: authors.get(N(existing.user)) ?? null,
      speech,
      speechDel: existing.speechDel,
      speechUp: existing.speechUp,
      speechDown: existing.speechDown,
      myVote,
      ...vs,
    };
  }

  // 候选池两路分开计席（十八轮 2026-10-28 张老师定；十九轮同日加进步席位分级）：
  //   ① 少将及以上现役 且 30 天内登录过（2026-10-26 张老师增列 last_login_time 条件——
  //      沉睡老将不参选，只约束①路；②路破纪录本身即活跃证明，不另设登录门槛）。恒 1 席。
  //   ② 30 天内破纪录 ∧ 排名上升（delta>0）现役。席位 = 1 + 进步加成 + 排位加成（十九轮）：
  //      进步加成（delta = 30 天窗口名次差，封禁修正后）：delta≥200 → +2；delta≥50 → +1；
  //      排位加成（今日总计时间榜名次）：≤100 → +2（百强仍有进步）；≤500 → +1。
  //      进步得多 / 排位已高仍进步者，席位更多。理论最高 5 席。
  //      （登录门槛：②路原不设，2026-11-02 张老师定统一走「7 日内未登录不参选」全局排除。）
  //   两路**分开计席**：两条都命中的用户席位叠加（不再 UNION 去重合一），
  //   再叠加头像加成——有头像者全部席位 ×2。
  // 封禁账号不入池（两路均 JOIN user.status=0；②路 rank_snapshot 残留 delta 的
  // 被封者一并滤掉，与 /grow 进步榜口径一致）。delta 本身已在快照刷新时做封禁修正
  // （ranksnap.ts：扣掉「别人被封白捡的名次」），delta>0 即真实名次上升。
  // 头像加成：有合法头像（/uploads/avatar/%、http 外链、旧站 '1'）者每份席位翻倍——
  // 鼓励上传真人照片，但不阻断无头像者参选。
  // rank_snapshot.ranks JSON 里今日名次的 key（如 $."2026-10-28"）。⚠️ 引号必须真实
  // 存在于字符串值里且**不带反斜杠**：此处是参数绑定（$queryRawUnsafe 传 ?），
  // 不走 SQL 字符串转义——原写法 `$.\\"…\\"` 让 MySQL 收到字面 `$.\"2026-10-28\"`，
  // JSON path 解析器直接报 3143 非法路径（position 16 实证，2026-10-29 线上首页 500）。
  // 日期 key 含连字符必须引号包裹，故值为带裸双引号的 $."日期"。
  const rankPath = `$."${today}"`;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint; seats: number; hasAvatar: number; lastLogin: bigint }>>(
    `SELECT s.id, 1 AS seats, u.last_login_time AS lastLogin,
            CASE WHEN u.avatar LIKE '/uploads/avatar/%' OR u.avatar LIKE 'http%' OR u.avatar = '1' THEN 1 ELSE 0 END AS hasAvatar
       FROM user_scores s
       JOIN \`user\` u ON u.id = s.id AND u.status = 0 AND u.last_login_time >= ?
       WHERE s.exp_time > 0 AND s.exp_time <= ?
     UNION ALL
     SELECT DISTINCT n.user,
            1 + CASE WHEN r.delta >= 200 THEN 2 WHEN r.delta >= 50 THEN 1 ELSE 0 END
              + CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(r.ranks, ?)) AS UNSIGNED) <= 100 THEN 2
                     WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(r.ranks, ?)) AS UNSIGNED) <= 500 THEN 1
                     ELSE 0 END AS seats,
            u.last_login_time AS lastLogin,
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
  const seen = new Map<number, { seats: number; hasAvatar: number; lastLogin: bigint }>();
  for (const r of rows) {
    const id = N(r.id);
    const cur = seen.get(id);
    if (cur) cur.seats += Number(r.seats);
    else seen.set(id, { seats: Number(r.seats), hasAvatar: Number(r.hasAvatar), lastLogin: r.lastLogin });
  }
  // 全局排除（2026-11-02 张老师定）：30 天内当选过的不参选 + 7 日内未登录过的不参选
  const candidates = [...seen.entries()].filter(
    ([id, { lastLogin }]) => !excluded.has(id) && isLoggedInWithin7Days(lastLogin)
  );
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
    // 预写制（2026-11-11 张老师定）：当选即提取该用户预先写好的感言镜像进 star 行——
    // 展示/赞踩闸/后台历史全继续读 star 行，user.star_speech 是每人一份的正本
    const winnerUser = await prisma.user.findUnique({
      where: { id: BigInt(winner) },
      select: { starSpeech: true },
    });
    const preWritten = winnerUser?.starSpeech ?? "";
    await prisma.star.create({
      data: { user: BigInt(winner), date: today, speech: preWritten, createTime: now, updateTime: now },
    });
    // 当选动态（2026-10-25 张老师定）：金色「当选了每日一星！」——
    // 只在本次请求真正写入 star 行时发（并发败者/已有行重访不重复发）；
    // 快照口径走 publishNews 缺省（当前 exp_time + 在榜状态）
    await publishNews({ type: 54, userId: winner });
    // 当选系统私信（2026-10-25 八轮张老师定）。同样只在真正当选的请求发一次；
    // 预写制下已写过感言的不再引导撰写
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p2 = (n: number) => (n < 10 ? "0" + n : String(n));
    const dateCn = `${d.getUTCFullYear()}年${p2(d.getUTCMonth() + 1)}月${p2(d.getUTCDate())}日`;
    await sendSystemMessage(
      winner,
      preWritten
        ? `恭喜您当选${dateCn}的每日一星！`
        : `恭喜您当选${dateCn}的每日一星，快去首页撰写当选感言吧！`
    ).catch(() => undefined); // 短信失败不阻断评选
  } catch {
    // 并发下另一请求已写入，以其为准
  }
  const row = await prisma.star.findUnique({ where: { date: today } });
  if (!row) return null;
  const [authors, myVote, vs] = await Promise.all([
    usersByIds([N(row.user)]),
    getMyVote(today, viewerUid ?? null),
    viewerSpeechState(viewerUid, row),
  ]);
  return {
    date: today,
    user: authors.get(N(row.user)) ?? null,
    speech: row.speech,
    speechDel: row.speechDel,
    speechUp: row.speechUp,
    speechDown: row.speechDown,
    myVote,
    ...vs,
  };
}

/** 感言字数上限（全角字计；十一轮张老师定 28 → 30） */
export const STAR_SPEECH_LIMIT = 30;

/**
 * 撰写当选感言（2026-11-11 张老师定改预写制；原「当日当选者一次性发」口径废止）：
 * 任何登录用户可写，落 user.star_speech **每人一份、一次性**（写后不可改）——
 * 当选当日由 getTodayStar 提取镜像到 star 行展示；被管理员删除后可重写一次
 * （starSpeechDel<2），第二次被删后永久禁止。
 * 内容闸门：checkSensitive 前置 + 拒绝 HTML 标签（< >）与外链特征
 * （http/https/www/.com 等）+ **AI 预检前置**（moderateText 判 review 即拒收，
 * 张老师 2026-11-11 定「过敏感词审核和 AI 预检后保存落库」；AI 调用失败/超时
 * 仍放行落库，返回 aiBackstop=true 由路由走 after() 后置复审兜底）。
 * 今日恰为本人当选时，同步镜像到当日 star 行（展示/赞踩/后台历史同源）。
 */
export async function setStarSpeech(
  userId: number,
  speech: string
): Promise<{ ok: boolean; error?: string; speech?: string; aiBackstop?: boolean }> {
  const u = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { starSpeech: true, starSpeechDel: true },
  });
  if (!u) {
    return { ok: false, error: "用户不存在" };
  }
  if (u.starSpeechDel >= 2) {
    return { ok: false, error: "感言已被删除两次，不能再撰写" };
  }
  // 已写过：默认锁定；唯一例外＝当日当选者的「再修改一次」（2026-11-11 张老师定，
  // 预写感言当选当日自动使用后可改一次，改完 star.speechEdited 置位图标转灰）
  const today = todayStr();
  const row = await prisma.star.findUnique({ where: { date: today } });
  const ownToday = !!(row && N(row.user) === userId);
  const editing = !!u.starSpeech;
  if (editing && !(ownToday && !row!.speechEdited)) {
    return { ok: false, error: "感言已撰写，不能修改" };
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
  // AI 预检前置（2026-11-11 张老师定）：判 review 直接拒收不落库；
  // 调用失败/超时放行（text-moderate 内部降级为 pass），aiBackstop 交路由后置复审
  const { moderateText, textModerationEnabled } = await import("./text-moderate");
  let aiBackstop = false;
  if (textModerationEnabled()) {
    const result = await moderateText(text);
    if (result.verdict === "review") {
      return { ok: false, error: "感言未通过审核，请修改后重试" };
    }
    aiBackstop = result.source !== "ai" && result.source !== "disabled";
  }
  const now = nowSec();
  await prisma.user.update({
    where: { id: BigInt(userId) },
    data: { starSpeech: text },
  });
  // 今日恰为本人当选：同步镜像到当日 star 行（首次写入或当日「再修改一次」都覆盖）；
  // 修改过的置 speechEdited（当日仅此一次）；改稿视同重新发表，赞/踩清零重投
  if (ownToday) {
    await prisma.star.update({
      where: { date: today },
      data: {
        speech: text,
        ...(editing ? { speechEdited: true } : {}),
        speechUp: 0,
        speechDown: 0,
        updateTime: now,
      },
    });
    await prisma.starVote.deleteMany({ where: { date: today } });
  }
  return { ok: true, speech: text, aiBackstop };
}

/**
 * 删除感言（九轮 2026-10-25 张老师定：管理员清理不当言论；十五轮补通知，十六轮定稿为系统消息）：
 * 仅管理员可调（route 层校验 role，此处只管数据）。
 * 预写制（2026-11-11）双清：user.star_speech 清空（图标解锁可重写）+ starSpeechDel+1
 * （≥2 永久不能再写）；当日 star 行 speech 清空 + speechDel+1（后台历史与展示同步），
 * 赞/踩计数与投票明细一并清零（感言撤下即无投票对象）。
 * 删除后发系统消息（is_system=1），文案带管理员名：
 * 「管理员xxx删除了你每日之星的感言，公开场合请注意措辞，合理发言」。
 */
export async function deleteStarSpeech(operatorId: number): Promise<void> {
  const today = todayStr();
  const row = await prisma.star.findUnique({ where: { date: today } });
  if (!row) return;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.user },
      data: { starSpeech: "", starSpeechDel: { increment: 1 } },
    }),
    prisma.star.update({
      where: { date: today },
      // 感言计数清零（2026-10-27）：感言撤下即无投票对象，旧计数不残留；
      // speechEdited 一并复位（删除解锁后重写/再改从头计）
      data: {
        speech: "",
        speechDel: { increment: 1 },
        speechUp: 0,
        speechDown: 0,
        speechEdited: false,
        updateTime: nowSec(),
      },
    }),
    // 投票明细一并清空：感言已撤下，释放投票额（重发后可再投）
    prisma.starVote.deleteMany({ where: { date: today } }),
  ]);
  if (row.speech) {
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
