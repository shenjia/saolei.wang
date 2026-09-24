// 首页：动态 + 最新录像 + 入伍新兵 + 十大元帅（移植 views/home/index）
// 2026-09-24 张老师要求：「雷界快讯」更名「动态」并缩减到 15 条；其下新增「最新录像」版块
// （15 条按上传时间倒序，带级别选择器与底部「加载更多」，交互与动态版块同构）。

import Link from "next/link";
import {
  getHomeNews,
  getNewbies,
  getNewsCount,
  getTopUsers,
  getVideoFeed,
  getVideoCount,
} from "@/lib/queries";
import { HOME_NEWS_NUMBER, HOME_VIDEO_NUMBER } from "@/lib/config";
import { timeOpposite, TIME_NEVER, isRecent } from "@/lib/format";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { VideoFeed } from "@/components/VideoFeed";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { DailyStar } from "@/components/DailyStar";
import { BbsLatest } from "@/components/BbsLatest";
import { SiteStats } from "@/components/SiteStats";
import { UserCard } from "@/components/UserCard";
import { title as assessTitle } from "@/lib/assess";
import { getSession } from "@/lib/auth";
import { getUserCard } from "@/lib/usercard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [news, newbies, top, session, newsTotal, videos, videoTotal] = await Promise.all([
    getHomeNews(),
    getNewbies(),
    getTopUsers(),
    getSession(),
    // 全站动态总数（「加载更多」括号内剩余条数口径；切等级筛选时由接口回传同口径总数）
    getNewsCount({}),
    getVideoFeed({ level: "all", limit: HOME_VIDEO_NUMBER }),
    getVideoCount({ level: "all" }),
  ]);
  const feed: NewsFeedItem[] = await Promise.all(
    news.map(async (n) => ({ news: n, title: await assessTitle(n.userScore) }))
  );
  // 入伍新兵按动态 user_score 评军衔（移植 home/_newbies.php 的 Assess::title）
  const newbieRows = await Promise.all(
    newbies.map(async (n) => ({ ...n, title: await assessTitle(n.userScore) }))
  );
  // 登录后「每日一星」版块替换为自己的信息卡片（2026-09-23 张老师要求）
  const myCard = session ? await getUserCard(session.uid) : null;

  return (
    <div id="page" className="two_columns">
    <ul id="home">
      <li className="main">
        <div id="news" className="box">
          <NewsFeed
            title="动态"
            initial={feed}
            pageSize={HOME_NEWS_NUMBER}
            initialHasMore={news.length === HOME_NEWS_NUMBER}
            initialTotal={newsTotal}
          />
        </div>
        <div id="video" className="box">
          <VideoFeed
            title="最新录像"
            initial={videos}
            pageSize={HOME_VIDEO_NUMBER}
            initialHasMore={videos.length === HOME_VIDEO_NUMBER}
            initialTotal={videoTotal}
          />
        </div>
      </li>
      <li className="sidebar">
        {myCard ? (
          <div id="my_card" className="box">
            <h2>我的地盘</h2>
            <UserCard card={myCard} own vertical />
          </div>
        ) : (
          <DailyStar />
        )}
        <div id="top" className="box">
          <Link href="/ranking" target="_blank">
            <h2>十大元帅</h2>
          </Link>
          <table cellPadding={0} cellSpacing={0} className="table full">
            <tbody>
              {top.map((u, i) => (
                <tr key={u.id}>
                  <td className="rank">
                    <em>{i + 1}</em>
                  </td>
                  <td className="user">
                    <AvatarCell id={u.id} name={u.chineseName} sex={u.sex} gender="small" link />
                    <TitleBadge title={u.title} link />
                  </td>
                  <td className={"time " + (isRecent(u.titleDate) ? "time--recent" : "time--old")}>
                    {timeOpposite(u.titleDate, TIME_NEVER)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div id="newbie" className="box">
          <h2>入伍新兵</h2>
          <table cellPadding={0} cellSpacing={0} className="table full">
            <tbody>
              {newbieRows.map((n) => (
                <tr key={n.id}>
                  <td className="user">
                    {n.author && (
                      <AvatarCell
                        id={n.author.id}
                        name={n.author.chineseName}
                        sex={n.author.sex}
                        gender="small"
                        link
                      />
                    )}
                    <TitleBadge title={n.title} link />
                  </td>
                  <td className={"time " + (isRecent(n.createTime) ? "time--recent" : "time--old")}>
                    {timeOpposite(n.createTime, TIME_NEVER)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <BbsLatest />
        <SiteStats />
      </li>
    </ul>
    </div>
  );
}
