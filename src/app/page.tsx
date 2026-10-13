// 首页：新闻 + 录像 + 入伍新兵 + 国内 TOP10（移植 views/home/index）
// 2026-09-24 张老师要求：「雷界快讯」更名「动态」并缩减到 15 条；其下新增录像版块
// （15 条按上传时间倒序，带级别选择器与底部「加载更多」，交互与新闻版块同构）；
// 右栏顶部「每日一星」「我的地盘」卡片均已撤下（后者 2026-09-24 张老师明示永久废弃：
// 该板块今后不再使用，直接删除，不再因登录态切换）。
// 2026-10-13 张老师要求：右栏顺序调整为 入伍新兵 → 论坛新帖 → 国内TOP10 → 站点统计
// （国内TOP10 从栏首移至论坛新帖之下；原名「十大元帅」更名，末列由时间改为「所在地区」）。
// 二轮定名：版块标题定为「新闻」「录像」，录像标题走灰色次级样式（字号保持 legacy 26px）。
// 2026-10-13 张老师要求：每日一星功能整体下线（评选触发一并移除）。

import Link from "next/link";
import {
  getHomeNews,
  getNewbies,
  getNewsCount,
  getTopUsers,
  getVideoFeed,
  getVideoCount,
} from "@/lib/queries";
import { HOME_NEWS_NUMBER, HOME_VIDEO_NUMBER, areaDisplay } from "@/lib/config";
import { timeOpposite, TIME_NEVER, isRecent } from "@/lib/format";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { VideoFeed } from "@/components/VideoFeed";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { BbsLatest } from "@/components/BbsLatest";
import { SiteStats } from "@/components/SiteStats";
import { title as assessTitle } from "@/lib/assess";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [news, newbies, top, newsTotal, videos, videoTotal] = await Promise.all([
    getHomeNews(),
    getNewbies(),
    getTopUsers(),
    // 首页新闻流总数（仅 NEWS_HOME_TYPES 口径；注册/头像/发帖/评论动态不进首页）
    getNewsCount({ home: true }),
    getVideoFeed({ level: "all", limit: HOME_VIDEO_NUMBER }),
    getVideoCount({ level: "all" }),
  ]);
  const feed: NewsFeedItem[] = news.map((n) => ({ news: n, title: assessTitle(n.expTime) }));
  // 入伍新兵按发布者实时高级时间评军衔（2026-10-13 SUB 制）
  const newbieRows = newbies.map((n) => ({ ...n, title: assessTitle(n.expTime) }));

  return (
    <div id="page" className="two_columns">
    <ul id="home">
      <li className="main">
        <div id="news" className="box">
          <NewsFeed
            title="新闻"
            homeOnly
            initial={feed}
            pageSize={HOME_NEWS_NUMBER}
            initialHasMore={news.length === HOME_NEWS_NUMBER}
            initialTotal={newsTotal}
          />
        </div>
        <div id="video" className="box">
          <VideoFeed
            title="录像"
            titleClassName="gray"
            initial={videos}
            pageSize={HOME_VIDEO_NUMBER}
            initialHasMore={videos.length === HOME_VIDEO_NUMBER}
            initialTotal={videoTotal}
          />
        </div>
      </li>
      <li className="sidebar">
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
        <div id="top" className="box">
          <Link href="/ranking" target="_blank">
            <h2>国内TOP10</h2>
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
                  <td className="area">{areaDisplay(u.area)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SiteStats />
      </li>
    </ul>
    </div>
  );
}
