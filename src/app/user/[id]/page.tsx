// 用户主页：成绩总表 + 最新动态 + 个人资料（移植 views/user/view）
// 访问即计人气（移植 2008 版 Player_Info 的 Click 计数）
// 2026-09-23 首个版块布局（张老师要求）：左侧正方形照片（OAuth 头像 →
//   /images/player/{id}.jpg → 默认头像）；全国/省份排名两行置于右上角
//   军衔徽章上方，居中显示
// 2026-09-24 二轮（张老师要求）：动态标题改「动态」、筛选器收进标题行右侧；
//   无上传录像隐藏「实力」雷达；统计数字默认亮灰、今日数据黄色高亮
// 2026-09-26（张老师要求）：纪事上方新增「录像」版块（加载更多翻页），
//   标题行右上角「上传录像」按钮（仅本人可见）

import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  getUserDetail,
  getUserNews,
  getUserRanks,
  getNewsCount,
  getUserTodayVideos,
  getUserActivity,
  getUserPracticeWins,
  getVideoList,
  getLevel3bvRanges,
  getUser3bvCollection,
} from "@/lib/queries";
import { getUserRecordCurves } from "@/lib/records";
import { getClicks, recordClick } from "@/lib/star";
import { getHistory } from "@/lib/history";
import {
  VIDEO_LEVELS,
  parseVideoListOrder,
  parseVideoListDir,
  LEVELS,
  LEVEL_NAMES,
  TITLE_COLORS,
  USER_NEWS_NUMBER,
  USER_VIDEO_NUMBER,
  AREA_OVERSEAS,
  areaDisplay,
  type Level,
  type VideoLevel,
  type VideoListOrder,
  type VideoListDir,
} from "@/lib/config";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { UserVideoSection } from "@/components/UserVideoSection";
import { HistoryBox } from "@/components/HistoryBox";
import { RadarChart } from "@/components/RadarChart";
import { Score3bvs, ScoreTime } from "@/components/Cells";
import { RankLabel } from "@/components/RankLabel";
import { UserRecordsSection } from "@/components/UserRecordsSection";
import type { MetricSectionData } from "@/components/RecordsCurves";
import { title as assessTitle, recordNewsExpTime } from "@/lib/assess";
import { formatDate } from "@/lib/format";
import { donateYuanPlain } from "@/lib/donate";
import { getThunderKingThreshold, dualTitles } from "@/lib/title-system";
import { ageOf, constellationText } from "@/lib/birth";
import { getRadarData } from "@/lib/radar";
import { resolveAvatarUrl, AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { prisma } from "@/lib/db";
import { SelfAvatar } from "@/components/SelfAvatar";
import { SendMessageButton } from "@/components/SendMessageButton";
import { BbvCollection } from "@/components/BbvCollection";
import { UserSigs } from "@/components/UserSigs";

export const dynamic = "force-dynamic";

/**
 * 页面标题（2026-10-13 张老师要求）：玩家姓名（拼音）| 扫雷网，
 * 与页面上 <h1>姓名</h1><h2>(拼音)</h2> 的展示口径一致。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = parseInt((await params).id, 10);
  if (!userId) return {};
  const u = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { chineseName: true, englishName: true },
  });
  if (!u) return {};
  const pinyin = u.englishName.trim();
  return { title: `${u.chineseName}${pinyin ? `(${pinyin})` : ""}` };
}

const PROFILE_FIELDS: [string, string][] = [
  ["nickname", "昵称"],
  ["interest", "爱好"],
  ["qq", "QQ"],
  ["mouse", "鼠标"],
  ["pad", "鼠标垫"],
];

/** 「纪录」板块筛选命名（2026-11-06）：级别口径与纪录页同款；图表小标题
 *  沿用纪录页「XX纪录」命名（指标 tab 标签 Time/3BV/s/STNB 在组件内定义） */
const RECORD_LEVEL_NAMES: Record<string, string> = {
  total: "总计",
  beg: "初级",
  int: "中级",
  exp: "高级",
};
const RECORD_METRIC_NAMES: Record<string, string> = {
  time: "Time纪录",
  "3bvs": "3BV/s纪录",
  stnb: "STNB纪录",
};

/** 录像版块级别筛选 tabs（2026-09-27 张老师要求，与动态筛选同款 ranking_tabs 大号版）；
 *  2026-10-16 移入客户端壳 UserVideoSection（就地切换不导航），此处不再需要 */

/**
 * 统计盒行（2026-10-13 张老师要求，样式与首页/录像页「数据统计」统一）：
 * 标签 | 数值（右对齐） | 今日增量（绿色括号，左对齐；无新增留空）。
 */
function StatRow({
  label,
  children,
  today,
}: {
  label: string;
  children: ReactNode;
  today?: number;
}) {
  const hasDelta = today !== undefined && today > 0;
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{children}</td>
      <td className="delta">{hasDelta ? `（+${today}）` : ""}</td>
    </tr>
  );
}

export default async function UserViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const userId = parseInt(id, 10);
  if (!userId) notFound();

  // 录像版块级别筛选（URL 即状态，与 /video 列表页同语义；链接整页刷新）
  const level = (VIDEO_LEVELS as readonly string[]).includes(sp.level ?? "")
    ? (sp.level as VideoLevel)
    : "all";
  // 录像版块排序（2026-10-16 张老师要求）：与 /video 列表页同语义——表头点击排序
  // （成绩/3BV/3BV/s/评论/点击/上传时间），默认上传时间（id）且不高亮；
  // 方向（2026-10-23 升降序切换）：非法/缺省回退该列默认方向
  const order: VideoListOrder = parseVideoListOrder(sp.order);
  const dir: VideoListDir = parseVideoListDir(sp.dir, order);
  // 显式态（2026-10-23）：URL 带 order（含 id）/dir——「上传时间」列高亮出箭头
  const videoSortExplicit = sp.order !== undefined || sp.dir !== undefined;
  // 录像版块搜索（2026-10-20 张老师要求：上传按钮换搜索框）：时间成绩/3BV 精确查询，
  // 与 /video 同语义（互斥三选一，本页 author 恒为 userId）
  const time = sp.time?.trim() || undefined;
  const bv = sp["3bv"]?.trim() || undefined;
  // 录像版块 NF 筛选开关（2026-10-20）：URL nf=1 开启，默认关
  const nf = sp.nf === "1";
  // 收集墙配色（2026-10-27 张老师要求筛选器改链接）：URL ?bbv=pb 明确指定时服务端
  // 直接渲染该配色（链接可中键新开/F5 不断链）；无参数时默认 3bv，客户端按 localStorage 校正
  const bbvMode: "3bv" | "pb" = sp.bbv === "pb" ? "pb" : "3bv";

  const detail = await getUserDetail(userId);
  if (!detail) notFound();

  // 计人气：同一 IP 同一天只计一次（十五轮起 ip 列带来源标记 |home，与卡片/每日一星跨来源去重）
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
  await recordClick(userId, ip, "home");
  const clicks = await getClicks(userId);

  // session 提前取（2026-10-23）：本人主页录像版块要放行自己的屏蔽盘（includeBanned），
  // 判定 isSelf 须在 getVideoList 之前
  const session = await getSession();
  const isSelf = !!session && session.uid === userId;

  const [news, newsTotal] = await Promise.all([
    getUserNews(userId, USER_NEWS_NUMBER),
    // 该玩家动态总数（「加载更多」括号内剩余条数口径）
    getNewsCount({ userId }),
  ]);
  const [history, ranks, userVideos, todayVideos, activity, practiceWins, bbvRanges, bbvCollection, userCurves] = await Promise.all([
    getHistory(userId),
    getUserRanks(userId),
  // 本人录像：与 /video?author= 同语义（排序由 URL order 决定，默认上传时间倒序）；
  // 每页 10 条（2026-09-26 张老师要求，与动态/纪事同口径，非 /video 列表的 20）；
  // time/bv/nf 搜索与 NF 筛选（2026-10-20）
  // 2026-10-23 张老师需求：本人主页放行自己的屏蔽盘（红 ✕ 标记，详情页可自助删除）；
  // 他人视角仍滤屏蔽（includeBanned 仅 isSelf）——排序/搜索路径不支持该放行，
  // 本人切排序/搜索时屏蔽盘自然不出列（默认上传时间序可见，够用）
  getVideoList({
    level, order, dir, author: userId, time, bv, nf,
    page: 1, pageSize: USER_VIDEO_NUMBER,
    ...(isSelf ? { includeBanned: true } : {}),
  }),
    // 今日新增录像（按级别），统计盒增量列用（2026-10-13 张老师要求）
    getUserTodayVideos(userId),
    // 发表文章（论坛主题）/ 发表评论数量 + 今日增量（2026-10-13 张老师要求）
    getUserActivity(userId),
    // 练习完成盘数 + 今日完成（2026-11-02 张老师要求，统计盒「录像总数」下新增一行；
    // 2026-11-06 改按完成口径——尝试可以刷，完成需要付出努力）
    getUserPracticeWins(userId),
    // 「3BV 收集」版块：全站区间（level_3bv_range 小表）+ 本人已收集集合（走索引，毫秒级）
    getLevel3bvRanges(),
    getUser3bvCollection(userId),
    // 「纪录」板块（2026-11-06）：个人纪录进步历程 12 条曲线（3 指标×4 级别），
    // uid 参与缓存 key 每人一份 24h TTL（lib/records.ts），无点时整块隐藏
    getUserRecordCurves(userId),
  ]);
  // 赞助金额（2026-11-02 张老师要求）：数据统计「发表评论」行下新增「赞助金额」，
  // 金额金色显示（donate_amt 例外类，压过统计盒数字亮灰）；没赞助过（合计 0）不显示整行。
  // ID 1（站长）特殊逻辑（2026-11-02 二次修订）：显示 max(−结余, 0)——
  // 结余 = 全站赞助收入（donate 合计）− 全站支出（donate_expense 合计）；
  // 结余为负（支出超收）取其负数为站长垫付额，结余 ≥ 0（转整）不显示。
  // 其余玩家显示本人赞助合计（donate，金额单位分）
  // 公开赞助金额开关（2026-11-02 张老师）：账户设置关闭（donate_hidden=1）后
  // 不查不显示——个人主页数据统计隐藏赞助金额行
  let donateCents = 0;
  if (detail.user.donateHidden) {
    // 已关闭公开：跳过查询，整行不渲染
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
  // 2026-11-06 张老师定：总司令=动态阈值档（快照快于阈值即评定，不再按身份特判）
  const kingTh = await getThunderKingThreshold();
  const feed: NewsFeedItem[] = news.map((n) => ({
    news: n,
    // 2026-10-28 张老师定：破纪录动态若产生军衔变化（从无到有/从低到高）按新军衔显示
    title: assessTitle(recordNewsExpTime(n.expTime, n.details, n.videoRealTime), kingTh),
    classic: n.authorTitles?.c ?? null,
  }));

  const { user, info, scores } = detail;
  const radar = await getRadarData(scores);

  // 「纪录」板块数据组装（2026-11-06）：12 条曲线 → 3 指标板块 × 4 级别点集。
  // 点的创造者恒为本人（n/en/s 取 detail）；军衔 hover 必须是「传那盘录像时」的
  // 军衔（2026-11-06 张老师指正）——每点用曲线数据层带回的 video 行内上传时刻
  // 快照（et/rk）dualTitles 批量换算，绝不能用当前 user_scores 快照（那会让
  // 整条曲线 hover 全显示最新军衔，就显示不出进步过程了）；全部无点时整块隐藏
  const recordPts = userCurves.flatMap((c) => c.points);
  const recordPairs = await dualTitles(
    recordPts.map((p) => ({ userId, expTime: p.et, ranked: p.rk === 1, sex: user.sex }))
  );
  const recordPairByPoint = new Map(recordPts.map((p, i) => [p, recordPairs[i]]));
  const recordSections: MetricSectionData[] = (["time", "3bvs", "stnb"] as const).map((metric) => ({
    metric,
    metricName: RECORD_METRIC_NAMES[metric],
    levels: (["total", "beg", "int", "exp"] as const).map((lv) => ({
      level: lv,
      levelName: RECORD_LEVEL_NAMES[lv],
      points: (userCurves.find((c) => c.metric === metric && c.level === lv)?.points ?? []).map((p) => ({
        v: p.vid,
        u: userId,
        n: user.chineseName,
        en: user.englishName,
        s: user.sex,
        x: p.ct,
        y: p.val,
        t: recordPairByPoint.get(p) ?? { m: "", c: null },
      })),
    })),
  }));
  const hasRecordCurves = recordSections.some((s) => s.levels.some((l) => l.points.length > 0));

  // 是不是「我自己的主页」——决定头像能不能点（2026-09-24 张老师需求：
  // 点击直接弹上传窗口 + 方形裁剪预览 + 待审气泡）
  // （isSelf 判定已提前到 Promise.all 之前，2026-10-23 屏蔽盘放行需要）

  // 只有自己的主页才需要查「有没有头像在审」（头像下方的「审核中」气泡），
  // 别人的主页不多跑这一趟查询
  const latestAvatarReview = isSelf
    ? await prisma.avatarReview.findFirst({
        where: { user: BigInt(userId) },
        orderBy: { id: "desc" },
        select: { status: true },
      })
    : null;
  const avatarPending = latestAvatarReview?.status === AVATAR_REVIEW_STATUS.PENDING;

  // 个人资料无可展示字段时整个版块隐藏（2026-09-23 张老师要求）
  // 2026-10-22「标识」行（user_sig 录像标识文字）也算可展示内容——
  // 有标识但没填资料的老用户，个人资料版块同样显示
  // 2026-11-03 生日也算（填了生日就显示「年龄」「星座」两个独立行）
  // 2026-11-04 显示年龄与星座开关：账户设置关闭（user.birthHidden）后视为未填，
  //   两个独立行与「版块是否显示」判定一并隐藏（账户设置页/后台玩家详情不受影响）
  const age = user.birthHidden ? null : ageOf(info?.birthday);
  const constellation = user.birthHidden ? null : constellationText(info?.birthday);
  const hasProfileFields =
    (!!info && PROFILE_FIELDS.some(([key]) => !!info[key as keyof typeof info])) ||
    age !== null ||
    constellation !== null;

  // 标识列表（user_sig，按注册先后 id 升序；过滤空串脏数据，2026-10-22）
  const sigs = (
    await prisma.userSig.findMany({
      where: { user: BigInt(userId), signature: { not: "" } },
      orderBy: { id: "asc" },
      select: { signature: true },
    })
  ).map((s) => s.signature);
  const showProfile = hasProfileFields || sigs.length > 0;

  // 照片优先级：新版上传头像（/uploads/avatar/…）→ OAuth 头像外链（http 开头）
  // → 老用户本地照片墙（头像实体为 /images/player/{id}.jpg，以文件存在为准）→ 默认头像
  const photo = resolveAvatarUrl(
    user.avatar,
    existsSync(path.join(process.cwd(), "public", "images", "player", `${userId}.jpg`))
      ? `/images/player/${userId}.jpg`
      : "/images/common/avatar.png",
  );
  const photoImg = <img className="avatar" src={photo} alt={user.chineseName} />;

  return (
    <div id="page" className="two_columns">
    <ul id="user_view">
      <li className="main">
        <div className="info box">
          {/* 自己的主页：头像可点，点击直接弹文件选择 + 方形裁剪浮窗（不跳账号中心）。
              别人的主页保持原样（裸 <img>，无链接无蒙层），不改动既有 DOM 与样式。 */}
          {isSelf ? (
            <SelfAvatar src={photo} alt={user.chineseName} pending={avatarPending} />
          ) : (
            photoImg
          )}
          <h1>{user.chineseName}</h1>
          <h2>({user.englishName})</h2>
          <span className={`gender big ${user.sex ? "male" : "female"}`}></span>
          {/* 2026-10-13 张老师定稿：原「发消息」灰色大按钮改为性别图标右侧的对话气泡小按钮，
              点击弹带遮罩的发信浮窗（输入框同录像评论），成功后屏中弹「发送成功」气泡 */}
          {/* 十二轮（2026-10-25）：按钮常驻——未登录/看自己灰置 + hover 提示 */}
          <SendMessageButton to={userId} name={user.chineseName} authorId={session?.uid ?? 0} />
          <div className="info_body">
            <table className="scores" cellPadding={0} cellSpacing={0}>
              <tbody>
                {LEVELS.map((level: Level) => {
                  const timeRec = scores[`${level}_time`];
                  const bvsRec = scores[`${level}_3bvs`];
                  return (
                    <tr key={level}>
                      <th>{LEVEL_NAMES[level]}</th>
                      <td>
                        <ScoreTime
                          score={timeRec?.score ?? null}
                          videoId={timeRec?.videoId ?? null}
                          date={timeRec?.date ?? null}
                          className={level}
                        />
                      </td>
                      <td>
                        <Score3bvs
                          score={bvsRec?.score ?? null}
                          videoId={bvsRec?.videoId ?? null}
                          date={bvsRec?.date ?? null}
                          className={level}
                          allowZero={level === "beg"}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="rank_label">
              {/* Phase 5 双体系：跟随观看者切换（旧体系=大号彩字无徽章） */}
              <RankLabel
                militaryTitle={detail.title}
                militaryColor={TITLE_COLORS[detail.title]}
                classic={detail.classicTitle}
              />
              {/* 封禁用户（2026-10-16 张老师要求）：不参与排行，原排名位置显示红色
                  「此用户已被封禁」；军衔徽章照常认定保留（上方 RankLabel 不受影响）；
                  海外玩家（外国人）：显示「海外第 X 名」（组内名次，2026-10-15 张老师要求，
                  口径与地区榜海外条目同构），不显示全国名次；无成绩保留灰「海外玩家」；
                  省份排名在上、全国排名在下（数字一般更小，09-24 张老师要求） */}
              {user.status !== 0 ? (
                <div className="ranks">
                  <span className="rank_line ranks_banned">此用户已被封禁</span>
                </div>
              ) : ranks && (ranks.area === AREA_OVERSEAS ? (
                <div className="ranks">
                  {ranks.areaPos !== null ? (
                    <span className="rank_line">
                      海外第 <em>{ranks.areaPos}</em> 名
                    </span>
                  ) : (
                    <span className="rank_line ranks_overseas">海外玩家</span>
                  )}
                </div>
              ) : (
                <div className="ranks">
                  {ranks.areaPos !== null && (
                    <span className="rank_line">
                      {areaDisplay(ranks.area)}第 <em>{ranks.areaPos}</em> 名
                    </span>
                  )}
                  <span className="rank_line">
                    全国第 <em>{ranks.national}</em> 名
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* 2026-10-13 张老师要求：窄屏（≤880 单列化）时「实力」雷达移到玩家面板下、
            动态上——主栏这份副本桌面端 display:none，≤880 显示并隐藏侧栏原件
            （globals.css .radar_main 规则）；桌面端仍在侧栏顶部 */}
        {detail.stat &&
          detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos > 0 && (
            <div className="radar box radar_main">
              <h2>实力</h2>
              <RadarChart data={radar} />
            </div>
          )}
        {/* 「纪录」板块（2026-11-06 张老师需求，11-37 二改：放动态板块上面）——个人纪录进步历程，
            级别筛选靠 title（默认总计）+ 指标筛选靠右（默认 Time），图表复刻
            /records 页 ChartCard；无任何个人纪录点时整块隐藏 */}
        {hasRecordCurves && <UserRecordsSection sections={recordSections} />}
        {news.length > 0 && (
          <div id="news" className="box">
            {/* 2026-09-27 张老师要求：动态/录像/纪事板块标题与其他页面同款 26px 大字，
                走首页「录像」同款 .gray 灰色次级样式（页面唯一黄 h1 是用户名）。
                此前 09-24 二轮的「h2 20px 灰不变大」已被本要求取代 */}
            <NewsFeed
              title={<h1 className="gray">动态</h1>}
              initial={feed}
              userId={userId}
              pageSize={USER_NEWS_NUMBER}
              initialHasMore={news.length === USER_NEWS_NUMBER}
              initialTotal={newsTotal}
            />
          </div>
        )}
        {/* 2026-09-26 张老师要求：纪事上方新增「录像」版块（本人录像，「加载更多」走列表模式翻页）。
            2026-09-27 二轮：加 全部/初级/中级/高级 级别筛选；标题与筛选器居中对齐（与动态版块同款编排）。
            2026-10-16 张老师要求：切级别/点表头排序就地生效不导航不跳顶（客户端壳，URL 仍即状态）。
            2026-10-20 张老师要求：右上角「上传录像」按钮换成搜索框（成绩/3BV/ID 查询）
            + NF 筛选开关；key=time-bv-nf——搜索软导航改变三项时强制重挂载换服务端数据
            （就地切级别/排序/NF 不动这三项，key 稳定不重挂载，与 VideoListSection 同法） */}
        <UserVideoSection
          key={`${time ?? ""}-${bv ?? ""}-${nf ? "1" : ""}`}
          userId={userId}
          initial={userVideos.videos}
          total={userVideos.total}
          pageSize={userVideos.pageSize}
          level={level}
          order={order}
          dir={dir}
          explicit={videoSortExplicit}
          time={time}
          bv={bv}
          nf={nf}
          self={isSelf}
        />
        <HistoryBox userId={userId} items={history} editable={session?.uid === userId} />
      </li>
      <li className="sidebar">
        {/* 2026-09-24 张老师要求：没有上传过录像的玩家不显示「实力」雷达板块 */}
        {detail.stat &&
          detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos > 0 && (
            <div className="radar box">
              <h2>实力</h2>
              <RadarChart data={radar} />
            </div>
          )}
        {/* 2026-10-13 张老师方案：侧栏「3BV 收集」版块（设计稿 v3 已确认），
            位置在实力雷达之下、个人资料之上；显示条件与雷达一致（有上传过录像才显示） */}
        {detail.stat &&
          detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos > 0 && (
            <BbvCollection
              userId={userId}
              ranges={bbvRanges}
              collected={bbvCollection}
              initialMode={bbvMode}
            />
          )}
        {showProfile && (
          <div className="profile box">
          <h2>个人资料</h2>
          <span className="id">
            ID.<em>{user.id}</em>
          </span>
          <hr />
          <table className="form">
            <tbody>
              {/* 昵称没填但填了生日：年龄/星座两行顶到最前（2026-11-03 张老师：星座独立成行） */}
              {!info?.nickname && age !== null && (
                <tr>
                  <th>年龄</th>
                  <td>{age}</td>
                </tr>
              )}
              {!info?.nickname && constellation && (
                <tr>
                  <th>星座</th>
                  <td>{constellation}</td>
                </tr>
              )}
              {PROFILE_FIELDS.map(([key, label]) => {
                const value = info?.[key as keyof NonNullable<typeof info>];
                if (!value) return null;
                return (
                  <Fragment key={key}>
                    <tr>
                      <th>{label}</th>
                      <td>{value}</td>
                    </tr>
                    {/* 年龄 / 星座（2026-11-03 张老师二改）：昵称行下各占独立一行 */}
                    {key === "nickname" && age !== null && (
                      <tr>
                        <th>年龄</th>
                        <td>{age}</td>
                      </tr>
                    )}
                    {key === "nickname" && constellation && (
                      <tr>
                        <th>星座</th>
                        <td>{constellation}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {/* 标识（user_sig 录像标识文字，2026-10-22 张老师要求）：
                  小字号 12px 尽量不换行；超过 3 条「…」按钮就地展开 */}
              {sigs.length > 0 && (
                <tr>
                  <th>标识</th>
                  <td>
                    <UserSigs items={sigs} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
        {detail.stat && (
          <div className="box stats_box">
            <h2>数据统计</h2>
            {/* 2026-10-13 张老师要求：与首页/录像页「数据统计」统一——数字亮灰加粗右对齐，
                今日新增独立成列（绿色括号，左对齐），无新增不显示。
                2026-11-02 张老师反馈：补 cellPadding/cellSpacing=0（全站其他表都有，
                独漏本表——浏览器默认 border-spacing 2px 让 hover 行背景被列间细线隔断） */}
            <table className="table full" cellPadding={0} cellSpacing={0}>
              <tbody>
                <StatRow label="累计人气" today={clicks.today}>
                  <em>{clicks.total}</em>
                </StatRow>
                <StatRow label="初级录像" today={todayVideos.beg}>
                  <Link href={`/video?author=${userId}&level=beg`} target="_blank" prefetch={false}>
                    <em>{detail.stat.begVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="中级录像" today={todayVideos.int}>
                  <Link href={`/video?author=${userId}&level=int`} target="_blank" prefetch={false}>
                    <em>{detail.stat.intVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="高级录像" today={todayVideos.exp}>
                  <Link href={`/video?author=${userId}&level=exp`} target="_blank" prefetch={false}>
                    <em>{detail.stat.expVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="录像总数" today={todayVideos.total}>
                  <Link href={`/video?author=${userId}`} target="_blank" prefetch={false}>
                    <em>{detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos}</em>
                  </Link>
                </StatRow>
                {/* 2026-11-02 张老师要求：录像总数下新增「练习盘数」，括号内今日练习；
                    2026-11-06 改按完成口径（尝试可以刷，完成需要付出努力）；
                    数据源 practice_daily 落盘（/online 每局上报，含排行局），不加链接 */}
                <StatRow label="练习盘数" today={practiceWins.today}>
                  <em>{practiceWins.total}</em>
                </StatRow>
                {/* 2026-10-13 张老师要求：新增发表文章（论坛主题）/ 发表评论两行，
                    口径与首页「数据统计」的论坛主题/录像评论一致（2026-10-22 首页行名更新） */}
                <StatRow label="发表文章" today={activity.postsToday}>
                  <em>{activity.posts}</em>
                </StatRow>
                <StatRow label="发表评论" today={activity.commentsToday}>
                  <em>{activity.comments}</em>
                </StatRow>
                {/* 2026-11-02 张老师要求：发表评论下新增「赞助金额」（金色）；
                    没赞助过不显示；ID 1 显示 max(−结余, 0)（查询见上方 donateCents） */}
                {donateCents > 0 && (
                  <StatRow label="赞助金额">
                    {/* 点击跳赞助页 /page/donate（2026-11-02 张老师要求）；
                        同盒录像数行同款新标签 + prefetch=false（_blank 必关预取铁律） */}
                    <Link href="/page/donate" target="_blank" prefetch={false}>
                      {/* 金色例外类 donate_amt（globals.css，压过统计盒数字亮灰规则） */}
                      <em className="donate_amt">{donateYuanPlain(donateCents)}</em>
                    </Link>
                  </StatRow>
                )}
                {/* 2026-10-28 张老师要求：末尾补 注册时间 / 最近登录（yyyy-mm-dd）；
                    lastLoginTime=0（从未登录过）显示 — */}
                <StatRow label="注册时间">
                  <em>{formatDate(user.createTime, "Y-m-d")}</em>
                </StatRow>
                <StatRow label="最近登录">
                  <em>{user.lastLoginTime > 0 ? formatDate(user.lastLoginTime, "Y-m-d") : "—"}</em>
                </StatRow>
              </tbody>
            </table>
          </div>
        )}
      </li>
    </ul>
    </div>
  );
}
