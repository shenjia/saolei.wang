// 比赛详情页（2026-11-13 二期，张老师 14:45 需求）
//
// · 左上板块与列表页完全一致（共用 TourBlock）；
// · 其下「动态」「录像」两个板块：
//   动态＝报名开始 / 玩家报名参加 / 比赛正式开始 / 玩家更新成绩 / 比赛正式结束
//   （开始/结束事件由列表页与详情页渲染期惰性补写，见 ensureTourLifecycleEvents）；
//   录像＝本比赛全部参赛录像按上传时间逆序（新在前，2026-11-22 张老师定），行渲染与首页录像流同源
//   （VideoRows），按比赛过滤、不去重；
// · 右栏：标准玩家卡片（UserPanel）+ 我的成绩 + 最新排名 + 数据统计。
// · 入口：列表页比赛标题 / 已结束按钮「查看结果」点击进入。
//
// 成绩口径（本期）：成绩＝video_info.real_time（排行成绩口径 2026-10-30 张老师定），
// 录像由管理员在后台录像管理手动挂接（video.tournament op）；跨级别混排公平性
// 口径待成绩采集期定。翻页参数：录像 page、动态 ep——两板块底部均挂标准 Pager
// （pageKey 区分页码参数、互带对方页码，2026-11-13 五轮张老师定）。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UserPanel } from "@/components/UserCard";
import { FlopSprites } from "@/components/FlopSprites";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";
import { TourEventsFeed } from "@/components/tournament/TourEventsFeed";
import { TourVideosFeed } from "@/components/tournament/TourVideosFeed";
import { TourBlock } from "@/components/tournament/TourBlock";
import { WindowPlayBox } from "@/components/tournament/WindowPlayBox";
import { SignupEntryBox } from "@/components/tournament/SignupEntryBox";
import { VideoSearch } from "@/components/VideoSearch";
import { scoreTime } from "@/lib/format";
import { LEVEL_NAMES, VIDEO_LEVELS, parseVideoListOrder, parseVideoListDir, type Level, type VideoLevel, type VideoListOrder, type VideoListDir } from "@/lib/config";
import { fmtTourScore, type TourMetricKey } from "@/lib/tour-metric";
import {
  ensureTourLifecycleEvents,
  fmtPrize,
  getTourDetailStats,
  getTourEventsPage,
  getTourMyResult,
  getTourRanking,
  getTourVideosPage,
  getTournamentDetail,
  parseScoreConfig,
  resolveTourIdParam,
} from "@/lib/tournament";

export const dynamic = "force-dynamic";

const TOUR_EVENT_PAGE_SIZE = 15;
const COMP_VIDEO_PAGE_SIZE = 20;
/* 计算过程气泡级别配色（2026-11-22 张老师定）：初级绿/中级橙/高级金，同 .comp_lv_plain */
const LV_TIP_COLOR: Record<string, string> = {
  beg: "comp_calc_beg",
  int: "comp_calc_int",
  exp: "comp_calc_exp",
};

/** 计算过程气泡（2026-11-22 张老师需求：右栏「成绩」板块的最好成绩 hover 也出
 *  同款气泡）——排行榜与我的成绩两处共用；各级别一行、级别名绿/橙/金，
 *  末行总计金色，保底直接写在过程中。渲染结构同 .comp_calc 实元素气泡。 */
function TourCalcTip({
  calc,
  metric,
  score,
}: {
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[];
  metric: TourMetricKey;
  score: number;
}) {
  return (
    <span className="comp_calc">
      {calc.map((seg) => {
        const lvName = seg.lv in LEVEL_NAMES ? LEVEL_NAMES[seg.lv as Level] : seg.lv;
        const fillPart =
          seg.fill > 0 && seg.floorScore > 0
            ? ` +${seg.fill}×保底${fmtTourScore(metric, seg.floorScore)}`
            : "";
        return (
          <span key={seg.lv} className="comp_calc_row">
            <i className={"comp_calc_lv" + (seg.lv in LV_TIP_COLOR ? ` ${LV_TIP_COLOR[seg.lv]}` : "")}>
              {lvName}
            </i>
            {`${seg.n}盘 ${fmtTourScore(metric, seg.real)}${fillPart}`}
          </span>
        );
      })}
      <span className="comp_calc_row comp_calc_total">总计 {fmtTourScore(metric, score)}</span>
    </span>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const resolved = await resolveTourIdParam(id);
  if (!resolved) return { title: "比赛" };
  const c = await getTournamentDetail(resolved);
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
  // 代号寻址（2026-11-19 张老师定）：/tournaments/<alias> 与 /tournaments/<id> 等价，
  // 代号优先（gsc13 → 比赛 21），避免裸 id 链接
  const compId = await resolveTourIdParam(id);
  if (!compId) notFound();

  const session = await getSession();
  const now = Math.floor(Date.now() / 1000);
  const c = await getTournamentDetail(compId, session?.uid);
  if (!c) notFound();

  // 惰性补写「正式开始 / 正式结束」动态（列表页渲染期已兜底，这里再兜一层）；
  // 窗口赛完赛动态（type=6）同函数惰性补写（计分口径字段全量行直传）
  await ensureTourLifecycleEvents(
    {
      id: c.id,
      startTime: c.start,
      endTime: c.end,
      windowHours: c.windowHours,
      scoreMode: c.scoreMode,
      scoreConfig: c.scoreConfig,
      includeLevels: c.levels.length ? c.levels.join(",") : undefined,
    },
    now
  );

  const ep = Math.max(parseInt(sp.ep ?? "1", 10) || 1, 1);
  const vp = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  // 录像区搜索（2026-11-18 深夜张老师定：同录像页，限本比赛范围内）——
  // author（玩家 id）与 time（成绩秒）互斥；vtime 输入格式同 /video（如 16.6）
  const vAuthor = Math.max(parseInt(sp.vauthor ?? "", 10) || 0, 0) || undefined;
  const vTimeRaw = (sp.vtime ?? "").trim();
  const vTime = vTimeRaw && Number.isFinite(Number(vTimeRaw)) && Number(vTimeRaw) > 0 ? Number(vTimeRaw) : undefined;
  // 3BV 搜索（2026-11-22 修翻页丢筛选时补齐：VideoSearch 比赛模式支持「3BV N」项，
  // URL 3bv=N；author 与 time/3bv 互斥口径不变）
  const vBvRaw = (sp["3bv"] ?? "").trim();
  const vBv = vBvRaw && /^\d+$/.test(vBvRaw) ? parseInt(vBvRaw, 10) : undefined;
  // 录像区级别筛选与表头排序（2026-11-22 张老师需求）：level 仅收比赛收录级别
  // （非法值回全部）；order/dir 同 /video 列表口径（表头点击切换，缺省=上传时间倒序）
  const levelRaw = sp.level ?? "";
  const videoLevel: VideoLevel | "all" = (VIDEO_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as VideoLevel)
    : "all";
  const videoOrder: VideoListOrder = parseVideoListOrder(sp.order);
  const videoDir: VideoListDir = parseVideoListDir(sp.dir, videoOrder);
  const videoExplicit = sp.order !== undefined || sp.dir !== undefined;
  // 比赛收录级别钳到录像三级别（Level 含 sum，但录像级别只有初/中/高——防御性过滤）
  const tourVideoLevels = c.levels.filter((l): l is VideoLevel =>
    (VIDEO_LEVELS as readonly string[]).includes(l)
  );
  const [events, videos, ranking, dstats, myResult, searchUser] = await Promise.all([
    getTourEventsPage(compId, ep, TOUR_EVENT_PAGE_SIZE),
    getTourVideosPage(compId, vp, COMP_VIDEO_PAGE_SIZE, {
      author: vAuthor,
      time: vTime,
      bv: vBv,
      level: videoLevel === "all" ? undefined : videoLevel,
      order: videoOrder,
      dir: videoDir,
    }),
    getTourRanking(compId, 10),
    getTourDetailStats(compId),
    session ? getTourMyResult(compId, session.uid) : Promise.resolve(null),
    vAuthor
      ? prisma.user.findUnique({ where: { id: BigInt(vAuthor) }, select: { chineseName: true } })
      : Promise.resolve(null),
  ]);
  // 计分数据项（2026-11-21 多数据项）：详情页成绩展示按项格式化
  const tourMetric: TourMetricKey = parseScoreConfig(c.scoreMode, c.scoreConfig)?.metric ?? "time";
  const tourDesc = parseScoreConfig(c.scoreMode, c.scoreConfig)?.desc ?? false;

  return (
    <div id="page" className="two_columns comp_page">
      {/* comp_detail：详情页专用钩子——主栏顶部留白（三轮 16:40 张老师定「主板块贴 header 不对」） */}
      <ul id="home" className="comp_detail">
        <li className="main">
          {/* 顶部板块：与列表页同一 TourBlock，detail 形态——标题恢复首页标准 26px、
              无「开赛」按钮（五轮 20:13，入口移右栏「开始比赛」双钮） */}
          <TourBlock c={c} now={now} loggedIn={!!session} detail myUid={session?.uid} />

          {/* 动态板块：标准翻页组件 = 首页同款 PageSlider（五轮 20:31 张老师定，
              client 壳 TourEventsFeed——换页走 URL、加载更多走 API 前缀整批替换）。
              key=ep：软导航换页时强制重挂载换入服务端新数据（铁律「客户端 Feed 软导航
              initial 不重置」，同 VideoListFeed key=author-time 判例） */}
          <div className="box comp_section">
            <h2>动态</h2>
            <TourEventsFeed
              key={`ep${ep}-vp${vp}`}
              compId={compId}
              scoreMetric={tourMetric}
              scoreDesc={tourDesc}
              initialRows={events.rows}
              initialPage={events.page}
              initialTotal={events.total}
              initialTotalPages={Math.max(1, Math.ceil(events.total / TOUR_EVENT_PAGE_SIZE))}
              videosPage={vp}
              pageSize={TOUR_EVENT_PAGE_SIZE}
            />
          </div>

          {/* 录像板块：本比赛全部参赛录像，默认上传时间逆序（新在前，2026-11-22 张老师定）、不去重；行渲染与首页录像流同源。
              2026-11-22 张老师需求：标题行下加级别筛选 tabs（仅比赛收录级别，全部+各级别）；
              表头可点击排序（成绩/3BV/计分项等，同 /video 列表交互，惜步杯按 crossings 排）。
              标准翻页组件同上（client 壳 TourVideosFeed）；
              key=page+筛选/排序：软导航改变筛选维度时强制重挂载换入服务端新数据（铁律）。
              右上角搜索框（2026-11-18 深夜张老师定：同录像页，限本比赛范围——
              VideoSearch scope=tour 跳 vauthor/vtime，作者与成绩互斥） */}
          <div className="box comp_section">
            <div className="comp_sec_head">
              <h2>录像</h2>
              <div className="video_search">
                <VideoSearch
                  scope="tour"
                  tourId={compId}
                  level=""
                  order="id"
                  author={vAuthor}
                  authorName={searchUser?.chineseName ?? ""}
                  time={vTimeRaw || undefined}
                  bv={vBvRaw || undefined}
                />
              </div>
            </div>
            <TourVideosFeed
              key={`vp${vp}-ep${ep}-va${vAuthor ?? 0}-vt${vTimeRaw}-vb${vBv ?? ""}-lv${videoLevel}-od${videoOrder}-dr${videoDir}`}
              compId={compId}
              initialVideos={videos.videos}
              initialPage={videos.page}
              initialTotal={videos.total}
              initialTotalPages={Math.max(1, Math.ceil(videos.total / COMP_VIDEO_PAGE_SIZE))}
              eventsPage={events.page}
              pageSize={COMP_VIDEO_PAGE_SIZE}
              tourMetric={tourMetric}
              levels={tourVideoLevels}
              level={videoLevel}
              order={videoOrder}
              dir={videoDir}
              explicit={videoExplicit}
              vAuthor={vAuthor}
              vTime={vTimeRaw || undefined}
              vBv={vBv}
            />
          </div>
        </li>

        <li className="sidebar">
          {/* 登录态：按钮区按状态分流（2026-11-19 早张老师定）：
              · 已结束 → 不显示任何按钮
              · 窗口赛（windowHours>0）进行中 → WindowPlayBox（未开赛单按钮+确认窗；
                已开赛个人标识+进入比赛/传录像双钮+倒计时色阶）
              · 集体赛：已开始且已报名 → 「进入比赛、传录像」双钮（原 #play_row）；
                未开始或未报名 → 「报名参赛」单按钮（风格同首页开始练习，图标=_PERSON
                旗标；已报名未开赛变绿色「已报名参赛」不可点）+ 下方倒计时
                「距离开赛还有…/距离比赛结束还有…」
              FlopSprites 提供 #face-flat 笑脸 symbol（纯 0×0 贴图库，无视觉占位） */}
          {session && c.status !== "ended" && (
            <>
              <FlopSprites />
              {c.windowHours > 0 ? (
                <WindowPlayBox
                  compId={compId}
                  windowHours={c.windowHours}
                  compEnd={c.end}
                  session0={c.mySession}
                  status={c.status}
                  joined={!!myResult?.joined}
                  start={c.start}
                  end={c.end}
                />
              ) : myResult?.joined && c.status === "active" ? (
                <div id="play_row">
                  <Link id="play_entry" href={`/online?c=${compId}`} target="_blank">
                    <svg viewBox="0 0 260 260" width="24" height="24" aria-hidden="true">
                      <use href="#face-flat" />
                    </svg>
                    <span>进入比赛</span>
                  </Link>
                  <Link id="upload_entry" href="/video/upload" target="_blank">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/upload-folder-icon.png" alt="" width={24} />
                    <span>传录像</span>
                  </Link>
                </div>
              ) : (
                <SignupEntryBox
                  compId={compId}
                  status={c.status}
                  joined={!!myResult?.joined}
                  start={c.start}
                  end={c.end}
                />
              )}
            </>
          )}

          {/* 登录态：标准玩家卡片（与录像详情页右栏同款）。
              三轮 16:40 张老师定：比赛页右栏不放实力雷达（hideRadar） */}
          {session && <UserPanel userId={session.uid} hideRadar />}

          {/* 成绩（登录态；三轮定「我的成绩」→「成绩」，标题 h2 与站内右栏板块一致）。
              未报名不显示（张老师 2026-11-18 详情页反馈）。
              最好成绩（2026-11-22 张老师定）：展示比赛总分（原单盘最好口径与排行榜
              排序值/名次对不上，且图表头部「最好成绩」本就是总分口径），hover 出与
              排行榜完全一致的计算过程气泡（复用 .comp_rank_time:hover .comp_calc 触发，
              锚点加 comp_score_tip 类保持同款样式） */}
          {session && myResult?.joined && (
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
                {myResult.score === null ? (
                  <b>—</b>
                ) : (
                  <b className="comp_score_tip">
                    {fmtTourScore(tourMetric, myResult.score)}
                    {myResult.calc && (
                      <TourCalcTip calc={myResult.calc} metric={tourMetric} score={myResult.score} />
                    )}
                  </b>
                )}
              </div>
              <div className="comp_stat_row">
                <span>当前名次</span>
                <b>{myResult.rank === null ? "—" : `第 ${myResult.rank} 名`}</b>
              </div>
            </div>
          )}

          {/* 排行榜（2026-11-18 晚张老师定：小字紧凑同热门录像；成绩 hover 出气泡
              展示计算过程——各级别分色、保底直接写在过程中，无单独 *N 标注。
              2026-11-21 多数据项：成绩格式化与保底单位按比赛 metric 折算。
              2026-11-22 张老师定：气泡改实元素（原 attr(data-tip) 纯文本在窄成绩锚点
              上被压成一字竖条，且无法逐行着色）——各级别一行、级别名绿/橙/金，
              末行总计金色。结构同 .pt_bubble 实元素气泡先例） */}
          <div className="box comp_stats">
            <h2>排行榜</h2>
            {ranking.length > 0 ? (
              <ol className="comp_rank">
                {ranking.map((r) => {
                  return (
                    <li key={r.uid} className="comp_rank_row">
                      <span className={"comp_rank_no" + (r.rank <= 3 ? " top" : "")}>{r.rank}</span>
                      <AvatarCell
                        id={r.uid}
                        name={r.name}
                        englishName={r.englishName}
                        sex={r.sex}
                        gender="small"
                        link
                        className="comp_rank_name"
                      />
                      <TitleBadge title={r.title} classic={r.classic} />
                      <Link
                        className="comp_rank_time"
                        href={r.videoId ? `/video/${r.videoId}` : `/user/${r.uid}`}
                      >
                        {fmtTourScore(tourMetric, r.time)}
                        {r.calc && r.calc.length > 0 && <TourCalcTip calc={r.calc} metric={tourMetric} score={r.time} />}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="comp_section_empty">暂无排名数据</div>
            )}
          </div>

          {/* 数据统计（本比赛口径。张老师 2026-11-19 定：报名人数与参赛人数分开统计——
              报名人数为 0 整行不显示（历届导入的旧比赛无报名数据，不存在统计误差）；
              参赛人数＝实际传了录像的持有者数） */}
          <div className="box comp_stats">
            <h2>数据统计</h2>
            {dstats.registrations > 0 && (
              <div className="comp_stat_row">
                <span>报名人数</span>
                <b>{dstats.registrations}</b>
              </div>
            )}
            <div className="comp_stat_row">
              <span>参赛人数</span>
              <b>{dstats.entries}</b>
            </div>
            <div className="comp_stat_row">
              <span>参赛录像</span>
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
