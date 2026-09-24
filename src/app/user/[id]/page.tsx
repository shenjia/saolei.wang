// 用户主页：成绩总表 + 最新动态 + 个人资料（移植 views/user/view）
// 访问即计人气（移植 2008 版 Player_Info 的 Click 计数）
// 2026-09-23 首个版块布局（张老师要求）：左侧正方形照片（OAuth 头像 →
//   /images/player/{id}.jpg → 默认头像）；全国/省份排名两行置于右上角
//   军衔徽章上方，居中显示

import { existsSync } from "node:fs";
import path from "node:path";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail, getUserNews, getUserRanks, getNewsCount } from "@/lib/queries";
import { getClicks, recordClick } from "@/lib/star";
import { getHistory } from "@/lib/history";
import { LEVELS, LEVEL_NAMES, TITLE_COLORS, USER_NEWS_NUMBER, areaDisplay, type Level } from "@/lib/config";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { HistoryBox } from "@/components/HistoryBox";
import { RadarChart } from "@/components/RadarChart";
import { Score3bvs, ScoreTime } from "@/components/Cells";
import { RankBadge } from "@/components/RankBadge";
import { title as assessTitle } from "@/lib/assess";
import { getRadarData } from "@/lib/radar";
import { resolveAvatarUrl } from "@/lib/avatar";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const PROFILE_FIELDS: [string, string][] = [
  ["nickname", "昵称"],
  ["selfIntro", "自我介绍"],
  ["interest", "兴趣爱好"],
  ["qq", "QQ"],
  ["mouse", "鼠标"],
  ["pad", "鼠标垫"],
];

export default async function UserViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = parseInt(id, 10);
  if (!userId) notFound();

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
  const [history, session, ranks] = await Promise.all([
    getHistory(userId),
    getSession(),
    getUserRanks(userId),
  ]);
  const feed: NewsFeedItem[] = await Promise.all(
    news.map(async (n) => ({ news: n, title: await assessTitle(n.userScore) }))
  );

  const { user, info, scores } = detail;
  const radar = await getRadarData(scores);

  // 是不是「我自己的主页」——决定头像能不能点（2026-09-24 张老师需求：
  // hover 提示「点击更换头像」，点击进头像上传处）
  const isSelf = !!session && session.uid === userId;

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
          {/* 自己的主页：头像可点，hover 出「点击更换头像」蒙层 → 跳到修改资料页头像区。
              别人的主页保持原样（裸 <img>，无链接无蒙层），不改动既有 DOM 与样式。 */}
          {isSelf ? (
            <Link href="/account/profile#avatar" className="avatar_slot" aria-label="点击更换头像">
              {photoImg}
              <span className="avatar_change">点击更换头像</span>
            </Link>
          ) : (
            photoImg
          )}
          <h1>{user.chineseName}</h1>
          <h2>({user.englishName})</h2>
          <span className={`gender big ${user.sex ? "male" : "female"}`}></span>
          {session && session.uid !== userId && (
            <Link href={`/message?to=${userId}`} className="button">
              发短消息
            </Link>
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
              {/* 省份排名在上、全国排名在下（数字一般更小，09-24 张老师要求） */}
              {ranks && (
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
              )}
            </div>
          </div>
        </div>
        {news.length > 0 && (
          <div id="news" className="box">
            <h2>进步历程</h2>
            <NewsFeed
              initial={feed}
              userId={userId}
              pageSize={USER_NEWS_NUMBER}
              initialHasMore={news.length === USER_NEWS_NUMBER}
              initialTotal={newsTotal}
            />
          </div>
        )}
        <HistoryBox userId={userId} items={history} editable={session?.uid === userId} />
      </li>
      <li className="sidebar">
        <div className="radar box">
          <h2>实力</h2>
          <RadarChart data={radar} />
        </div>
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
            <h2>统计</h2>
            <table className="table full">
              <tbody>
                <tr>
                  <td>人气</td>
                  <td>
                    <em>{clicks.total}</em>
                    {clicks.today > 0 && `（今日 +${clicks.today}）`}
                  </td>
                </tr>
                <tr>
                  <td>初级录像</td>
                  <td>
                    <Link href={`/video?author=${userId}&level=beg`} target="_blank">
                      <em>{detail.stat.begVideos}</em>
                    </Link>
                  </td>
                </tr>
                <tr>
                  <td>中级录像</td>
                  <td>
                    <Link href={`/video?author=${userId}&level=int`} target="_blank">
                      <em>{detail.stat.intVideos}</em>
                    </Link>
                  </td>
                </tr>
                <tr>
                  <td>高级录像</td>
                  <td>
                    <Link href={`/video?author=${userId}&level=exp`} target="_blank">
                      <em>{detail.stat.expVideos}</em>
                    </Link>
                  </td>
                </tr>
                <tr>
                  <td>录像总数</td>
                  <td>
                    <Link href={`/video?author=${userId}`} target="_blank">
                      <em>{detail.stat.begVideos + detail.stat.intVideos + detail.stat.expVideos}</em>
                    </Link>
                  </td>
                </tr>
                <tr>
                  <td>最近登录</td>
                  <td>
                    {user.lastLoginTime ? formatDate(user.lastLoginTime, "Y-m-d H:i") : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </li>
    </ul>
    </div>
  );
}
