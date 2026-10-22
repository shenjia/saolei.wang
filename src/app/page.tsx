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
// 2026-10-22 张老师要求：管理员登录态在侧栏「开始练习」按钮下方显示待审录像数
// （数字金色）+「去审核」小按钮直达 /admin/review；待审清零时不渲染。

import Link from "next/link";
import {
  getHomeNews,
  getHotVideos,
  getNewbies,
  getNewsCount,
  getVideoFeed,
  getVideoCount,
} from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmailBindNotice } from "@/components/EmailBindNotice";
import { HOME_NEWS_NUMBER, HOME_VIDEO_NUMBER, VIDEO_STATUS, isManager } from "@/lib/config";
import { timeOpposite, TIME_NEVER, isRecent } from "@/lib/format";
import { NewsFeed, type NewsFeedItem } from "@/components/NewsFeed";
import { VideoFeed } from "@/components/VideoFeed";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { BbsLatest } from "@/components/BbsLatest";
import { SystemText } from "@/components/SystemText";
import { SiteStats } from "@/components/SiteStats";
import { FlopSprites } from "@/components/FlopSprites";
import { VideoHot } from "@/components/VideoHot";
import { title as assessTitle } from "@/lib/assess";
import { getThunderKingId } from "@/lib/title-system";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // 邮箱绑定提醒（2026-10-15）：登录且未绑定已验证邮箱 → 遮罩浮层（2026-10-16 改版）
  const session = await getSession();
  let showEmailNotice = false;
  if (session) {
    const auth = await prisma.userAuth.findUnique({
      where: { id: BigInt(session.uid) },
      select: { emailVerified: true },
    });
    showEmailNotice = !auth || Number(auth.emailVerified) === 0;
  }

  const [news, newbies, hot, newsTotal, videos, videoTotal] = await Promise.all([
    getHomeNews(),
    getNewbies(),
    // 热门录像（2026-10-20 张老师要求：替换原「排行前十」板块，数据源原 /video 右栏同款）
    getHotVideos(10),
    // 首页新闻流总数（仅 NEWS_HOME_TYPES 口径；注册/头像/发帖/评论动态不进首页）
    getNewsCount({ home: true }),
    getVideoFeed({ level: "all", limit: HOME_VIDEO_NUMBER }),
    getVideoCount({ level: "all" }),
  ]);
  // 2026-10-19 总司令=雷界第一人特判（快照口径：按发布时刻是否榜首评定）
  const king = await getThunderKingId();
  const feed: NewsFeedItem[] = news.map((n) => ({
    news: n,
    title: assessTitle(n.expTime, king > 0 && king === (n.author?.id ?? 0)),
    classic: n.authorTitles?.c ?? null,
  }));
  // 入伍新兵按发布者实时高级时间评军衔（2026-10-13 SUB 制）
  const newbieRows = newbies.map((n) => ({
    ...n,
    title: assessTitle(n.expTime, king > 0 && king === (n.author?.id ?? 0)),
    classic: n.authorTitles?.c ?? null,
  }));

  // 待审录像数（2026-10-22 张老师要求）：仅管理员登录态查一次，
  // 侧栏「开始练习」按钮下方显示「N 部录像待审核」+「去审核」直达 /admin/review
  let pendingReview = 0;
  if (session && isManager(session.role)) {
    pendingReview = await prisma.video.count({
      where: { status: VIDEO_STATUS.NORMAL },
    });
  }

  return (
    <>
    {/* 邮箱绑定提醒浮层（2026-10-16 张老师改版：提醒条 → 遮罩浮层 + 以后再说 24h）。
        渲染在 #page 之外：≤605px #page 有整页 zoom，fixed 遮罩做在里面会缩放失真 */}
    {showEmailNotice && <EmailBindNotice />}
    <div id="page" className="two_columns">
    <ul id="home">
      <li className="main">
        {/* 移动端（≤880 单列带）置顶「开始练习」大按钮：高度翻倍（总高 100 CSS px）、
            字号 26px、图标 36px；桌面隐藏（display:none），侧栏小按钮照旧（2026-10-15 张老师要求）。
            注：≤605 视口有整页 zoom（0.65~0.94 档），渲染尺寸同比例缩放 */}
        <Link id="play_entry_top" href="/online">
          <svg viewBox="0 0 260 260" width="36" height="36" aria-hidden="true">
            <use href="#face-flat" />
          </svg>
          <span>开始练习</span>
        </Link>
        {/* 管理员待审提示行（2026-10-22）：移动端副本（桌面隐藏），紧贴置顶大按钮下方 */}
        {pendingReview > 0 && (
          <div id="review_entry_top">
            <span className="n">
              <b>{pendingReview}</b> 部录像待审核
            </span>
            <Link className="go" href="/admin/review">
              去审核
            </Link>
          </div>
        )}
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
        {/* 管理员待审提示行（2026-10-22 张老师要求）：待审录像数金色 +
            「去审核」小按钮直达后台审核页；仅待审>0 时渲染 */}
        {pendingReview > 0 && (
          <div id="review_entry">
            <span className="n">
              <b>{pendingReview}</b> 部录像待审核
            </span>
            <Link className="go" href="/admin/review">
              去审核
            </Link>
          </div>
        )}
        <div id="newbie" className="box">
          {/* 板块名随观看者称号体系切换：军衔制「入伍新兵」/ 旧版「新人报到」（2026-10-18 张老师定） */}
          <h2>
            <SystemText m="入伍新兵" c="新人报到" />
          </h2>
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
                    <TitleBadge title={n.title} classic={n.classic} link />
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
        {/* 热门录像（2026-10-20 张老师要求：替换原「排行前十」板块——按上传时间倒序
            至少两条评论的录像；版块样式沿用 VideoHot（原 /video 右栏同款紧凑行）。
            原 #top 排行前十板块与 getTopUsers 查询一并撤下 */}
        <VideoHot videos={hot} />
        <SiteStats />
      </li>
    </ul>
    </div>
    </>
  );
}
