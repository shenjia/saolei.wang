// 用户主页：成绩总表 + 最新动态 + 个人资料（移植 views/user/view）
// 访问即计人气（移植 2008 版 Player_Info 的 Click 计数）
// 2026-09-23 首个版块布局（张老师要求）：左侧正方形照片（OAuth 头像 →
//   /images/player/{id}.jpg → 默认头像），军衔用大徽章标签放在记录信息右侧

import { existsSync } from "node:fs";
import path from "node:path";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail, getUserNews, getUserAreaRank } from "@/lib/queries";
import { getClicks, recordClick } from "@/lib/star";
import { getHistory } from "@/lib/history";
import { LEVELS, LEVEL_NAMES, NEWS_PAGESIZE, TITLE_COLORS, USER_NEWS_NUMBER, areaDisplay, type Level } from "@/lib/config";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { HistoryBox } from "@/components/HistoryBox";
import { RadarChart } from "@/components/RadarChart";
import { Score3bvs, ScoreTime } from "@/components/Cells";
import { RankBadge } from "@/components/RankBadge";
import { title as assessTitle } from "@/lib/assess";
import { getRadarData } from "@/lib/radar";
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

  const news = await getUserNews(userId, USER_NEWS_NUMBER);
  const [history, session, areaRank] = await Promise.all([
    getHistory(userId),
    getSession(),
    getUserAreaRank(detail.user.area),
  ]);
  const feed: NewsFeedItem[] = await Promise.all(
    news.map(async (n) => ({ news: n, title: await assessTitle(n.userScore) }))
  );

  const { user, info, scores } = detail;
  const radar = await getRadarData(scores);

  // 照片：新用户 OAuth 头像 URL（http 开头）→ 老用户本地照片墙（avatar 是 0/1 标记位，
  // 照片实体为 /images/player/{id}.jpg，以文件存在为准）→ 默认头像
  const photo = user.avatar.startsWith("http")
    ? user.avatar
    : existsSync(path.join(process.cwd(), "public", "images", "player", `${userId}.jpg`))
      ? `/images/player/${userId}.jpg`
      : "/images/common/avatar.png";

  return (
    <div id="page" className="two_columns">
    <ul id="user_view">
      <li className="main">
        <div className="info box">
          <img className="avatar" src={photo} alt={user.chineseName} />
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
              <Link href="/world" title="军衔体系">
                <RankBadge title={detail.title} size={72} />
                <span className="rank_name" style={{ color: TITLE_COLORS[detail.title] }}>
                  {detail.title}
                </span>
              </Link>
              {/* 所在地区战力名次（地区榜按综合排行指数的全国排名）：上军区、下名次两行 */}
              {areaRank && (
                <Link
                  href={`/area?name=${encodeURIComponent(areaRank.area)}`}
                  target="_blank"
                  className="area_rank"
                  title="地区榜"
                >
                  <span className="area_name">{areaDisplay(areaRank.area)}军区</span>
                  <span className="area_pos">
                    战力第 <em>{areaRank.pos}</em> 名
                  </span>
                </Link>
              )}
            </div>
          </div>
        </div>
        {news.length > 0 && (
          <div id="news" className="box">
            <h2>最新动态</h2>
            <NewsFeed
              initial={feed}
              userId={userId}
              pageSize={NEWS_PAGESIZE}
              initialHasMore={news.length === USER_NEWS_NUMBER}
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
