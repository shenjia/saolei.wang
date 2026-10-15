// 首页：新闻 + 录像 + 入伍新兵 + 排行前十（移植 views/home/index）
// 2026-09-24 张老师要求：「雷界快讯」更名「动态」并缩减到 15 条；其下新增录像版块
// （15 条按上传时间倒序，带级别选择器与底部「加载更多」，交互与新闻版块同构）；
// 右栏顶部「每日一星」「我的地盘」卡片均已撤下（后者 2026-09-24 张老师明示永久废弃：
// 该板块今后不再使用，直接删除，不再因登录态切换）。
// 2026-10-13 张老师要求：右栏顺序调整为 入伍新兵 → 论坛新帖 → 排行前十 → 站点统计
// （排行前十 从栏首移至论坛新帖之下；原名「十大元帅」更名，末列由时间改为「所在地区」）。
// 二轮定名：版块标题定为「新闻」「录像」，录像标题走灰色次级样式（字号保持 legacy 26px）。
// 2026-10-13 张老师要求：每日一星功能整体下线（评选触发一并移除）。
// 2026-10-15 张老师要求：按钮文案「开一局」→「开始练习」；「国内TOP10」→「排行前十」；
// 移动端（≤880 单列带）「开始练习」改为页面顶部大按钮（新闻上方，高度 2 倍、字体图标加大，
// 桌面版侧栏按钮与置顶版并存、由 CSS 按断点显隐）。

import Link from "next/link";
import {
  getHomeNews,
  getNewbies,
  getNewsCount,
  getTopUsers,
  getVideoFeed,
  getVideoCount,
} from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmailBindNotice } from "@/components/EmailBindNotice";
import { HOME_NEWS_NUMBER, HOME_VIDEO_NUMBER, areaDisplay } from "@/lib/config";
import { timeOpposite, TIME_NEVER, isRecent } from "@/lib/format";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { VideoFeed } from "@/components/VideoFeed";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { BbsLatest } from "@/components/BbsLatest";
import { SiteStats } from "@/components/SiteStats";
import { FlopSprites } from "@/components/FlopSprites";
import { title as assessTitle } from "@/lib/assess";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // 邮箱绑定提醒（2026-10-15）：登录且未绑定已验证邮箱 → 内容区顶部提醒条
  const session = await getSession();
  let showEmailNotice = false;
  if (session) {
    const auth = await prisma.userAuth.findUnique({
      where: { id: BigInt(session.uid) },
      select: { emailVerified: true },
    });
    showEmailNotice = !auth || Number(auth.emailVerified) === 0;
  }

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
        {showEmailNotice && <EmailBindNotice />}
        {/* 移动端（≤880 单列带）置顶「开始练习」大按钮：高度翻倍（总高 100 CSS px）、
            字号 26px、图标 36px；桌面隐藏（display:none），侧栏小按钮照旧（2026-10-15 张老师要求）。
            注：≤605 视口有整页 zoom（0.65~0.94 档），渲染尺寸同比例缩放 */}
        <Link id="play_entry_top" href="/online">
          <svg viewBox="0 0 260 260" width="36" height="36" aria-hidden="true">
            <use href="#face-flat" />
          </svg>
          <span>开始练习</span>
        </Link>
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
        {/* 「开始练习」按钮（2026-10-14 张老师定）：扁平笑脸银灰样式、与侧栏板块同宽，
            位于入伍新兵之上；为腾出其高度，论坛新帖由 8 条减为 6 条，保持左右栏底部基本对齐。
            仅桌面（≥881）显示；移动端由主栏顶部 #play_entry_top 接管（2026-10-15） */}
        <FlopSprites />
        <Link id="play_entry" href="/online">
          <svg viewBox="0 0 260 260" width="24" height="24" aria-hidden="true">
            <use href="#face-flat" />
          </svg>
          <span>开始练习</span>
        </Link>
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
            <h2>排行前十</h2>
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
