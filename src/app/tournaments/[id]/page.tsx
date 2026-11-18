// 比赛详情页（2026-11-13 二期，张老师 14:45 需求）
//
// · 左上板块与列表页完全一致（共用 CompBlock）；
// · 其下「动态」「录像」两个板块：
//   动态＝报名开始 / 玩家报名参加 / 比赛正式开始 / 玩家更新成绩 / 比赛正式结束
//   （开始/结束事件由列表页与详情页渲染期惰性补写，见 ensureCompLifecycleEvents）；
//   录像＝本比赛全部参赛录像按时间正序（早在前），行渲染与首页录像流同源
//   （VideoRows），按比赛过滤、不去重；
// · 右栏：标准玩家卡片（UserPanel）+ 我的成绩 + 最新排名 + 数据统计。
// · 入口：列表页比赛标题 / 已结束按钮「查看结果」点击进入。
//
// 成绩口径（本期）：成绩＝video_info.real_time（排行成绩口径 2026-10-30 张老师定），
// 录像由管理员在后台录像管理手动挂接（video.competition op）；跨级别混排公平性
// 口径待成绩采集期定。翻页参数：录像 page、动态 ep——两板块底部均挂标准 Pager
// （pageKey 区分页码参数、互带对方页码，2026-11-13 五轮张老师定）。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UserPanel } from "@/components/UserCard";
import { FlopSprites } from "@/components/FlopSprites";
import { CompEventsFeed } from "@/components/competition/CompEventsFeed";
import { CompVideosFeed } from "@/components/competition/CompVideosFeed";
import { CompBlock } from "@/components/competition/CompBlock";
import { scoreTime } from "@/lib/format";
import {
  ensureCompLifecycleEvents,
  fmtPrize,
  getCompDetailStats,
  getCompEventsPage,
  getCompMyResult,
  getCompRanking,
  getCompVideosPage,
  getCompetitionDetail,
} from "@/lib/competition";

export const dynamic = "force-dynamic";

const COMP_EVENT_PAGE_SIZE = 20;
const COMP_VIDEO_PAGE_SIZE = 20;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const compId = parseInt(id, 10);
  if (!compId) return { title: "比赛" };
  const c = await getCompetitionDetail(compId);
  return { title: c ? `${c.name}` : "比赛" };
}

export default async function CompetitionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const compId = parseInt(id, 10);
  if (!Number.isInteger(compId) || compId <= 0) notFound();

  const session = await getSession();
  const now = Math.floor(Date.now() / 1000);
  const c = await getCompetitionDetail(compId, session?.uid);
  if (!c) notFound();

  // 惰性补写「正式开始 / 正式结束」动态（列表页渲染期已兜底，这里再兜一层）
  await ensureCompLifecycleEvents({ id: c.id, startTime: c.start, endTime: c.end }, now);

  const ep = Math.max(parseInt(sp.ep ?? "1", 10) || 1, 1);
  const vp = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const [events, videos, ranking, dstats, myResult] = await Promise.all([
    getCompEventsPage(compId, ep, COMP_EVENT_PAGE_SIZE),
    getCompVideosPage(compId, vp, COMP_VIDEO_PAGE_SIZE),
    getCompRanking(compId, 10),
    getCompDetailStats(compId),
    session ? getCompMyResult(compId, session.uid) : Promise.resolve(null),
  ]);

  return (
    <div id="page" className="two_columns comp_page">
      {/* comp_detail：详情页专用钩子——主栏顶部留白（三轮 16:40 张老师定「主板块贴 header 不对」） */}
      <ul id="home" className="comp_detail">
        <li className="main">
          {/* 顶部板块：与列表页同一 CompBlock，detail 形态——标题恢复首页标准 26px、
              无「开赛」按钮（五轮 20:13，入口移右栏「开始比赛」双钮） */}
          <CompBlock c={c} now={now} loggedIn={!!session} detail />

          {/* 动态板块：标准翻页组件 = 首页同款 PageSlider（五轮 20:31 张老师定，
              client 壳 CompEventsFeed——换页走 URL、加载更多走 API 前缀整批替换） */}
          <div className="box comp_section">
            <h2>动态</h2>
            <CompEventsFeed
              compId={compId}
              initialRows={events.rows}
              initialPage={events.page}
              initialTotal={events.total}
              initialTotalPages={Math.max(1, Math.ceil(events.total / COMP_EVENT_PAGE_SIZE))}
              videosPage={vp}
              pageSize={COMP_EVENT_PAGE_SIZE}
            />
          </div>

          {/* 录像板块：本比赛全部参赛录像，时间正序、不去重；行渲染与首页录像流同源。
              标准翻页组件同上（client 壳 CompVideosFeed） */}
          <div className="box comp_section">
            <h2>录像</h2>
            <CompVideosFeed
              compId={compId}
              initialVideos={videos.videos}
              initialPage={videos.page}
              initialTotal={videos.total}
              initialTotalPages={Math.max(1, Math.ceil(videos.total / COMP_VIDEO_PAGE_SIZE))}
              eventsPage={events.page}
              pageSize={COMP_VIDEO_PAGE_SIZE}
            />
          </div>
        </li>

        <li className="sidebar">
          {/* 登录态：首页同款双钮行（五轮 20:13 复刻 #play_row）——「开始比赛」进比赛模式
              （/online?c=比赛ID，逻辑同列表页原「开赛」钮，新标签页），「传录像」新标签页上传。
              FlopSprites 提供 #face-flat 笑脸 symbol（纯 0×0 贴图库，无视觉占位） */}
          {session && (
            <>
              <FlopSprites />
              <div id="play_row">
                <Link id="play_entry" href={`/online?c=${compId}`} target="_blank">
                  <svg viewBox="0 0 260 260" width="24" height="24" aria-hidden="true">
                    <use href="#face-flat" />
                  </svg>
                  <span>开始比赛</span>
                </Link>
                <Link id="upload_entry" href="/video/upload" target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/images/upload-folder-icon.png" alt="" width={24} />
                  <span>传录像</span>
                </Link>
              </div>
            </>
          )}

          {/* 登录态：标准玩家卡片（与录像详情页右栏同款）。
              三轮 16:40 张老师定：比赛页右栏不放实力雷达（hideRadar） */}
          {session && <UserPanel userId={session.uid} hideRadar />}

          {/* 成绩（登录态；三轮定「我的成绩」→「成绩」，标题 h2 与站内右栏板块一致） */}
          {session && myResult && (
            <div className="box comp_stats">
              <h2>成绩</h2>
              <div className="comp_stat_row">
                <span>报名状态</span>
                <b>{myResult.joined ? "已报名" : "未报名"}</b>
              </div>
              <div className="comp_stat_row">
                <span>参赛录像</span>
                <b>{myResult.videos}</b>
              </div>
              <div className="comp_stat_row">
                <span>最好成绩</span>
                <b>{myResult.bestTime === null ? "—" : scoreTime(myResult.bestTime)}</b>
              </div>
              <div className="comp_stat_row">
                <span>当前名次</span>
                <b>{myResult.rank === null ? "—" : `第 ${myResult.rank} 名`}</b>
              </div>
            </div>
          )}

          {/* 排行榜（本期口径：挂接录像按玩家最好 real_time 升序；三轮定「最新排名」→「排行榜」） */}
          <div className="box comp_stats">
            <h2>排行榜</h2>
            {ranking.length > 0 ? (
              <ol className="comp_rank">
                {ranking.map((r) => (
                  <li key={r.uid} className="comp_rank_row">
                    <span className={"comp_rank_no" + (r.rank <= 3 ? " top" : "")}>{r.rank}</span>
                    <Link className="comp_rank_name" href={`/user/${r.uid}`}>
                      {r.name}
                    </Link>
                    <Link className="comp_rank_time" href={`/video/${r.videoId}`}>
                      {scoreTime(r.time)}
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="comp_section_empty">暂无排名数据</div>
            )}
          </div>

          {/* 数据统计（本比赛口径） */}
          <div className="box comp_stats">
            <h2>数据统计</h2>
            <div className="comp_stat_row">
              <span>参赛人数</span>
              <b>{dstats.entries}</b>
            </div>
            <div className="comp_stat_row">
              <span>录像数量</span>
              <b>{dstats.videos}</b>
            </div>
            <div className="comp_stat_row">
              <span>总奖金</span>
              <b className="gold">{fmtPrize(c.prizeTotal)}</b>
            </div>
          </div>
        </li>
      </ul>
    </div>
  );
}
