// 用户主页：成绩总表 + 最新动态 + 个人资料（移植 views/user/view）
// 访问即计人气（移植 2008 版 Player_Info 的 Click 计数）

import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail, getUserNews } from "@/lib/queries";
import { getClicks, recordClick } from "@/lib/star";
import { getHistory } from "@/lib/history";
import { LEVELS, LEVEL_NAMES, NEWS_PAGESIZE, USER_NEWS_NUMBER, type Level } from "@/lib/config";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { HistoryBox } from "@/components/HistoryBox";
import { RadarChart } from "@/components/RadarChart";
import { Score3bvs, ScoreTime, TitleBadge } from "@/components/Cells";
import { title as assessTitle } from "@/lib/assess";
import { getRadarData } from "@/lib/radar";

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
  const [history, session] = await Promise.all([getHistory(userId), getSession()]);
  const feed: NewsFeedItem[] = await Promise.all(
    news.map(async (n) => ({ news: n, title: await assessTitle(n.userScore) }))
  );

  const { user, info, scores } = detail;
  const radar = await getRadarData(scores);

  return (
    <div id="page" className="two_columns">
    <ul id="user_view">
      <li className="main">
        <div className="info box">
          <h1>{user.chineseName}</h1>
          <h2>({user.englishName})</h2>
          <span className={`gender big ${user.sex ? "male" : "female"}`}></span>
          <TitleBadge title={detail.title} link />
          {session && session.uid !== userId && (
            <Link href={`/message?to=${userId}`} className="button">
              发短消息
            </Link>
          )}
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
      </li>
      <li className="sidebar">
        <div className="radar box">
          <h2>实力</h2>
          <RadarChart data={radar} />
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
                  <td>登录次数</td>
                  <td>{detail.stat.loginTimes}</td>
                </tr>
                <tr>
                  <td>积分</td>
                  <td>{detail.stat.points}</td>
                </tr>
                <tr>
                  <td>初级录像</td>
                  <td>{detail.stat.begVideos}</td>
                </tr>
                <tr>
                  <td>中级录像</td>
                  <td>{detail.stat.intVideos}</td>
                </tr>
                <tr>
                  <td>高级录像</td>
                  <td>{detail.stat.expVideos}</td>
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
