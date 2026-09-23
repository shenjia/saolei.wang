// 首页：雷界动态 + 入伍新兵 + 十大元帅（移植 views/home/index）

import Link from "next/link";
import { getHomeNews, getNewbies, getTopUsers } from "@/lib/queries";
import { HOME_NEWS_NUMBER, NEWS_PAGESIZE } from "@/lib/config";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
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
  const [news, newbies, top, session] = await Promise.all([
    getHomeNews(),
    getNewbies(),
    getTopUsers(),
    getSession(),
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
          <h1>雷界动态</h1>
          <NewsFeed
            initial={feed}
            pageSize={NEWS_PAGESIZE}
            initialHasMore={news.length === HOME_NEWS_NUMBER}
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
                  </td>
                  <td>
                    <TitleBadge title={u.title} link />
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
                  <td className="time">{timeOpposite(n.createTime, TIME_NEVER)}</td>
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
