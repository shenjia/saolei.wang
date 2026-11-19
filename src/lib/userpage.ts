// 用户主页数据打包缓存（2026-11-10 张老师定：60 秒总缓存，方案 A）
//
// 个人页单次渲染 ~20 趟查询且持续加码（活跃雷达/活跃指数/赞助/标识……），
// 其中 14 趟与 session 无关、与 URL 参数无关，按用户 id 打包成一份
// unstable_cache（60s TTL，userId 自动并入缓存键，每人一份）：
//   - 他人/匿名视角走缓存：DB 压力从每请求 14 趟降为每用户每分钟 1 趟；
//   - 本人视角 fresh=true 直查 impl 绕过缓存——改资料/传头像/改标识/
//     自己的新录像统计即时可见（张老师口径：只有自己看自己不走缓存）。
//   页内「加载更多」翻页走 API 直查实时，不受影响；封禁/审核等管理动作
//   最迟 60s 内体现在他人视角（与全站 60s 缓存口径一致）。
//
// ⚠️ 本文件必须独立于 queries.ts：queries.ts 会被客户端 bundle 引到
//   （BbsFeed → bbs.ts → queries.ts），next/cache 顶层 import 进去会炸
//   Pages/Client 编译（dev 实证 500，见 queries.ts L820 注释）。
//   本文件只被服务端页面（src/app/user/[id]/page.tsx）import。
//
// ⚠️ unstable_cache 落盘走 JSON 序列化：打包载荷禁 Map/BigInt/Date——
//   BigInt 各查询出口已转 number；唯一例外 getUser3bvCollection 返回
//   Map，此处摊平为 [3BV, 格] 元组数组（bbvCells），读取侧重组。
//   载荷量级：news 10 条 + 收集墙 ≤328 格 + 其余小对象，单人 <100KB，
//   远低于 2MB 上限（perf-stnb 铁律）。
//
// 不打包的查询（保持原路径）：
//   - getUserRanks：已有 per-user 600s 缓存（user-ranks-v3）
//   - getUserRecordCurves：已有 per-user 24h 缓存 + 渲染侧 dualTitles 配对
//   - getVideoList：键空间含 level/order/dir/time/bv/nf/isSelf（URL 即状态），
//     键空间无界不缓存；author 走索引、join count 另有 60s 缓存
//   - avatarReview：仅本人视角查询（fresh 路径天然覆盖）

import { unstable_cache } from "next/cache";
import {
  getUserDetail,
  getUserNews,
  getNewsCount,
  getUserTodayVideos,
  getUserActivity,
  getUserActivityIndex,
  getUserPracticeWins,
  getLevel3bvRanges,
  getUser3bvCollection,
  type UserDetail,
  type NewsItem,
  type BbvCell,
} from "./queries";
import { getHistory, type HistoryItem } from "./history";
import { getClicks } from "./star";
import { getRadarData, type RadarPoint } from "./radar";
import { getActiveRadar, type ActiveRadarDataPoint } from "./activerank";
import { getThunderKingThreshold } from "./title-system";
import { getRankedToday } from "./practice";
import { prisma } from "./db";
import { USER_NEWS_NUMBER, type VideoLevel } from "./config";

/** 用户主页打包数据（形态全 JSON 安全：number/string/boolean/plain object/null） */
export interface UserPageBundle {
  detail: UserDetail;
  clicks: { total: number; today: number };
  news: NewsItem[];
  newsTotal: number;
  history: HistoryItem[];
  todayVideos: { beg: number; int: number; exp: number; total: number };
  activity: { posts: number; postsToday: number; comments: number; commentsToday: number };
  actIndex: { total: number; practice: number; videos: number; comments: number; login: number; watch: number };
  /** 今日活跃值（2026-11-11 张老师定统一数据源：与首页/练习页同走 getRankedToday，
   *  loginFromTable 口径——打包缓存访客无关，看别人的主页时对方没来过不白送登录点） */
  todayAct: number;
  practiceWins: { total: number; today: number };
  bbvRanges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  /** 收集墙摊平形态（Map 不能过缓存序列化）；读取侧 new Map(bbvCells[level]) 重组 */
  bbvCells: Record<VideoLevel, [number, BbvCell][]>;
  donateCents: number;
  kingTh: number;
  radar: RadarPoint[];
  activeRadar: ActiveRadarDataPoint[];
  sigs: string[];
}

async function getUserPageBundleImpl(userId: number): Promise<UserPageBundle | null> {
  const detail = await getUserDetail(userId);
  if (!detail) return null;

  const [
    clicks,
    news,
    newsTotal,
    history,
    todayVideos,
    activity,
    actIndex,
    rankedToday,
    practiceWins,
    bbvRanges,
    bbvCollection,
    activeRadar,
    kingTh,
    sigs,
  ] = await Promise.all([
    getClicks(userId),
    getUserNews(userId, USER_NEWS_NUMBER),
    getNewsCount({ userId }),
    getHistory(userId),
    getUserTodayVideos(userId),
    getUserActivity(userId),
    getUserActivityIndex(userId),
    // 今日活跃值（与首页/练习页同源 getRankedToday；loginFromTable 见接口注释）
    getRankedToday(userId, { loginFromTable: true }),
    getUserPracticeWins(userId),
    getLevel3bvRanges(),
    getUser3bvCollection(userId),
    getActiveRadar(userId),
    getThunderKingThreshold(),
    // 标识列表（user_sig，按注册先后 id 升序；过滤空串脏数据，2026-10-22）
    prisma.userSig
      .findMany({
        where: { user: BigInt(userId), signature: { not: "" } },
        orderBy: { id: "asc" },
        select: { signature: true },
      })
      .then((rows) => rows.map((s) => s.signature)),
  ]);

  // 赞助金额（从 page.tsx 原样迁入）：ID 1（站长）显示 max(−结余, 0)；
  // 关闭公开（donateHidden）跳过查询整行不渲染；其余显示本人赞助合计（单位分）
  let donateCents = 0;
  if (detail.user.donateHidden) {
    // 已关闭公开：跳过查询
  } else if (userId === 1) {
    const [income, expense] = await Promise.all([
      prisma.donate.aggregate({ _sum: { amount: true } }),
      prisma.donateExpense.aggregate({ _sum: { amount: true } }),
    ]);
    donateCents = Math.max(
      Number(expense._sum.amount ?? 0) - Number(income._sum.amount ?? 0),
      0,
    );
  } else {
    const agg = await prisma.donate.aggregate({
      where: { user: BigInt(userId) },
      _sum: { amount: true },
    });
    donateCents = Number(agg._sum.amount ?? 0);
  }

  // 实力雷达（依赖 detail.scores，串在 detail 之后，与原页面时序一致）
  const radar = await getRadarData(detail.scores);

  return {
    detail,
    clicks,
    news,
    newsTotal,
    history,
    todayVideos,
    activity,
    actIndex,
    todayAct: rankedToday.act,
    practiceWins,
    bbvRanges,
    bbvCells: {
      beg: [...bbvCollection.beg.entries()],
      int: [...bbvCollection.int.entries()],
      exp: [...bbvCollection.exp.entries()],
    },
    donateCents,
    kingTh,
    radar,
    activeRadar,
    sigs,
  };
}

// 60s TTL；userId 自动并入缓存键（fetchUserRanks 同款模式）。
// 改打包内任何查询逻辑必须升键版本号（unstable_cache 文件持久化，dev 重启不清）。
// v2（2026-11-11）：新增 todayAct（今日活跃值，与首页/练习页同源 getRankedToday）。
const fetchUserPageBundle = unstable_cache(getUserPageBundleImpl, ["user-page-v2"], {
  revalidate: 60,
});

/**
 * 用户主页打包数据入口。
 * @param fresh true=直查绕过缓存（本人视角：自己的改动即时可见，也不写缓存）
 */
export async function getUserPageData(userId: number, fresh = false): Promise<UserPageBundle | null> {
  return fresh ? getUserPageBundleImpl(userId) : fetchUserPageBundle(userId);
}
