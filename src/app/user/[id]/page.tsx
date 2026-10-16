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
import type { ReactNode } from "react";
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
  getVideoList,
  getLevel3bvRanges,
  getUser3bvCollection,
} from "@/lib/queries";
import { getClicks, recordClick } from "@/lib/star";
import { getHistory } from "@/lib/history";
import { LEVELS, LEVEL_NAMES, TITLE_COLORS, USER_NEWS_NUMBER, USER_VIDEO_NUMBER, VIDEO_LEVELS, AREA_OVERSEAS, areaDisplay, type Level, type VideoLevel } from "@/lib/config";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { VideoListFeed } from "@/components/VideoListFeed";
import { HistoryBox } from "@/components/HistoryBox";
import { RadarChart } from "@/components/RadarChart";
import { Score3bvs, ScoreTime } from "@/components/Cells";
import { RankBadge } from "@/components/RankBadge";
import { title as assessTitle } from "@/lib/assess";
import { getRadarData } from "@/lib/radar";
import { resolveAvatarUrl, AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { prisma } from "@/lib/db";
import { SelfAvatar } from "@/components/SelfAvatar";
import { SendMessageButton } from "@/components/SendMessageButton";
import { BbvCollection } from "@/components/BbvCollection";

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

/** 录像版块级别筛选 tabs（2026-09-27 张老师要求，与动态筛选同款 ranking_tabs 大号版） */
const VIDEO_LEVEL_TABS: [string, string][] = [
  ["all", "全部"],
  ["beg", "初级"],
  ["int", "中级"],
  ["exp", "高级"],
];

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

  const detail = await getUserDetail(userId);
  if (!detail) notFound();

  // 计人气：同一 IP 同一天只计一次
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
  await recordClick(userId, ip);
  const clicks = await getClicks(userId);

  const [news, newsTotal] = await Promise.all([
    getUserNews(userId, USER_NEWS_NUMBER),
    // 该玩家动态总数（「加载更多」括号内剩余条数口径）
    getNewsCount({ userId }),
  ]);
  const [history, session, ranks, userVideos, todayVideos, activity, bbvRanges, bbvCollection] = await Promise.all([
    getHistory(userId),
    getSession(),
    getUserRanks(userId),
    // 本人录像：按上传时间倒序第一页（与 /video?author= 同语义）；
    // 每页 10 条（2026-09-26 张老师要求，与动态/纪事同口径，非 /video 列表的 20）
    getVideoList({ level, order: "id", author: userId, page: 1, pageSize: USER_VIDEO_NUMBER }),
    // 今日新增录像（按级别），统计盒增量列用（2026-10-13 张老师要求）
    getUserTodayVideos(userId),
    // 发表文章（论坛主题）/ 发表评论数量 + 今日增量（2026-10-13 张老师要求）
    getUserActivity(userId),
    // 「3BV 收集」版块：全站区间（level_3bv_range 小表）+ 本人已收集集合（走索引，毫秒级）
    getLevel3bvRanges(),
    getUser3bvCollection(userId),
  ]);
  const feed: NewsFeedItem[] = news.map((n) => ({ news: n, title: assessTitle(n.expTime) }));

  const { user, info, scores } = detail;
  const radar = await getRadarData(scores);

  // 是不是「我自己的主页」——决定头像能不能点（2026-09-24 张老师需求：
  // 点击直接弹上传窗口 + 方形裁剪预览 + 待审气泡）
  const isSelf = !!session && session.uid === userId;

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
  const hasProfileFields =
    !!info && PROFILE_FIELDS.some(([key]) => !!info[key as keyof typeof info]);

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
          {session && session.uid !== userId && (
            <SendMessageButton to={userId} name={user.chineseName} />
          )}
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
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="rank_label">
              <Link href="/titles" title="军衔体系">
                <RankBadge title={detail.title} size={72} />
                <span className="rank_name" style={{ color: TITLE_COLORS[detail.title] }}>
                  {detail.title}
                </span>
              </Link>
              {/* 封禁用户（2026-10-16 张老师要求）：不参与排行，原排名位置显示红色
                  「此用户已被封禁」；军衔徽章照常认定保留（上方 RankBadge 不受影响）；
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
        {/* 2026-09-26 张老师要求：纪事上方新增「录像」版块（本人录像按上传时间倒序，
            「加载更多」走列表模式翻页），右上角「上传录像」按钮（仅本人可见）。
            2026-10-13 三轮（张老师要求）：按钮改回 button.active 同款深底绿字，
            与论坛「发布主题」风格统一（删 globals.css 定制绿底覆盖）。
            2026-09-27 二轮：加 全部/初级/中级/高级 级别筛选（URL 即状态），
            标题与筛选器居中对齐（与动态版块同款编排） */}
        <div className="box" id="user_videos">
          <div className="video_head_box">
            <h1 className="gray">录像</h1>
            {/* 与动态板块筛选同构：div.ranking_tabs > a/span（结构一致保证样式一致）。
                scroll={false}：筛选切换保持视口原位（2026-09-27 三轮张老师要求：
                默认软导航滚顶，切换级别后页面跳到最上面） */}
            <div className="ranking_tabs user_video_tabs">
              {VIDEO_LEVEL_TABS.map(([value, label]) =>
                value === level ? (
                  <span key={value} className="current">
                    {label}
                  </span>
                ) : (
                  <Link scroll={false} key={value} href={`/user/${userId}?level=${value}`}>
                    {label}
                  </Link>
                )
              )}
            </div>
            {isSelf && (
              <Link href="/video/upload" className="button active small video_upload_btn">
                上传录像
              </Link>
            )}
          </div>
          {/* key=筛选串铁律：切级别必须强制重挂载（useState(initial) 不重置） */}
          <VideoListFeed
            key={`${userId}-${level}`}
            initial={userVideos.videos}
            total={userVideos.total}
            pageSize={userVideos.pageSize}
            query={{ level, order: "id", author: userId }}
          />
        </div>
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
            <BbvCollection ranges={bbvRanges} collected={bbvCollection} />
          )}
        {hasProfileFields && (
          <div className="profile box">
          <h2>个人资料</h2>
          <span className="id">
            ID.<em>{user.id}</em>
          </span>
          <hr />
          <table className="form">
            <tbody>
              {PROFILE_FIELDS.map(([key, label]) => {
                const value = info?.[key as keyof NonNullable<typeof info>];
                if (!value) return null;
                return (
                  <tr key={key}>
                    <th>{label}</th>
                    <td>{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {detail.stat && (
          <div className="box">
            <h2>数据统计</h2>
            {/* 2026-10-13 张老师要求：与首页/录像页「数据统计」统一——数字亮灰加粗右对齐，
                今日新增独立成列（绿色括号，左对齐），无新增不显示 */}
            <table className="table full">
              <tbody>
                <StatRow label="人气" today={clicks.today}>
                  <em>{clicks.total}</em>
                </StatRow>
                <StatRow label="初级录像" today={todayVideos.beg}>
                  <Link href={`/video?author=${userId}&level=beg`} target="_blank">
                    <em>{detail.stat.begVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="中级录像" today={todayVideos.int}>
                  <Link href={`/video?author=${userId}&level=int`} target="_blank">
                    <em>{detail.stat.intVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="高级录像" today={todayVideos.exp}>
                  <Link href={`/video?author=${userId}&level=exp`} target="_blank">
                    <em>{detail.stat.expVideos}</em>
                  </Link>
                </StatRow>
                <StatRow label="录像总数" today={todayVideos.total}>
                  <Link href={`/video?author=${userId}`} target="_blank">
                    <em>{detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos}</em>
                  </Link>
                </StatRow>
                {/* 2026-10-13 张老师要求：新增发表文章（论坛主题）/ 发表评论两行，
                    口径与首页「数据统计」的发布主题/发布评论一致 */}
                <StatRow label="发表文章" today={activity.postsToday}>
                  <em>{activity.posts}</em>
                </StatRow>
                <StatRow label="发表评论" today={activity.commentsToday}>
                  <em>{activity.comments}</em>
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
