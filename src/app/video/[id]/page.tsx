// 录像详情页（移植 views/video/view）

import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getComments, getCommentsCount, getVideoDetail, videoScores } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { clientIp, uniqueVideoAction } from "@/lib/stat";
import {
  COMMENT_TOP_NUMBER,
  INVALID_3BVS_TIP,
  INVALID_STNB_TIP,
  INVALID_TIME_TIP,
  LEVEL_NAMES,
  MIN_3BV_FOR_3BVS,
  TERM_3BVS_TIP,
  TERM_3BV_TIP,
  TERM_NF_TIP,
  TERM_STNB_TIP,
  VIDEO_STATUS_NAMES,
  isManager,
  type VideoLevel,
} from "@/lib/config";
import { score3bvs, scoreTime } from "@/lib/format";
import { RelTime } from "@/components/RelTime";
import { AvatarCell, PlayerTip, TitleBadge } from "@/components/Cells";
import { SoftwareIcon } from "@/components/VideoRows";
import { UserPanel } from "@/components/UserCard";
import { CommentSection } from "@/components/Comments";
// 原地回放（2026-10-15 张老师需求：点播放后棋盘原地重演，复用练习页回放引擎；
// rmv/解析失败自动兜底 flop 全屏播放器——FlopPlayer 由 VideoReplayProvider 按需挂）
import { VideoReplayProvider, VideoReplayBoard, VideoReplayButton } from "@/components/VideoReplay";
import { VideoSelfDeleteButton } from "@/components/VideoSelfDeleteButton";
import { VideoAnalysisRadar } from "@/components/VideoAnalysis";
import { getVideoAnalysis, getVideoPerformance } from "@/lib/videoanalysis";
import { ensureVideoBoard } from "@/lib/videometrics";
// 综合评级的等级配色（与雷达图同一份，统一在 videoscore.ts 维护）
import { gradeColor } from "@/lib/videoscore";
import { VIDEO_STATUS } from "@/lib/config";

export const dynamic = "force-dynamic";

/** 级别 class（与录像列表 VideoRows 的 lv_* 口径一致） */
const LV_CLS: Record<string, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

/** 浏览器标签页标题（2026-10-16 张老师定）：
    「高级 xx.xx NF (3bv123) 人名的录像 | 扫雷网 Saolei.wang」（后缀由根布局 template 拼接） */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) return {};
  const video = await getVideoDetail(videoId);
  if (!video) return {};
  // 屏蔽盘不给普通访客（含爬虫/meta 抓取）任何元数据；管理员与录像主人可见
  // （后台审核链直接链到前台详情页，2026-10-22；本人自助删除入口 2026-10-23）
  if (video.status === VIDEO_STATUS.BANNED) {
    const session = await getSession();
    if (!session || (!isManager(session.role) && session.uid !== video.author?.id)) return {};
  }
  const level = video.level as VideoLevel;
  const time = scoreTime(videoScores(video.board3bv, video.realTime, level).time);
  const score = [
    LEVEL_NAMES[level] ?? video.level,
    time,
    video.noflag && "NF",
    `(3bv${video.board3bv})`,
  ]
    .filter(Boolean)
    .join(" ");
  const name = video.author?.chineseName ?? "未知玩家";
  return { title: `${score} ${name}的录像` };
}

export default async function VideoViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) notFound();

  const video = await getVideoDetail(videoId);
  if (!video) notFound();
  // 2026-10-22 张老师指令：已屏蔽录像不进前台（列表/搜索/动态已滤，此处详情页
  // 补口）——仅管理员可见（后台审核/管理页直接链到本页播放与下载，属「后台除外」）
  // 2026-10-23 张老师需求补充：录像主人本人也放行——屏蔽后只在个人主页可见（红 ✕），
  // 本人从详情页可自助删除（下载按钮旁红色删除钮）
  if (video.status === VIDEO_STATUS.BANNED) {
    const guard = await getSession();
    if (!guard || (!isManager(guard.role) && guard.uid !== video.author?.id)) notFound();
  }
  // 2026-10-22：先取 session 再取评论——本人待审行（status=5）按 viewerUid 放行
  const session = await getSession();
  // ?comment= 深链锚点（2026-10-29 消息通知落地，评论区渐进定位该评论）
  const anchorComment = parseInt((await searchParams).comment ?? "", 10) || 0;
  const [comments, commentTotal, clicksNow] = await Promise.all([
    getComments(videoId, 0, COMMENT_TOP_NUMBER, session?.uid ?? null),
    // 评论总数（「加载更多」括号内剩余条数口径，按实际行数而非 video_stat 冗余计数）
    getCommentsCount(videoId, session?.uid ?? null),
    // 点击计数（移植 actionView 的 uniqueAction('click')）——返回计数后最新值，
    // 页面显示用它兜底（2026-11-05 张老师：浏览永远不应为 0，首访即显示 1）
    (async () => uniqueVideoAction(videoId, "click", clientIp(await headers())))(),
  ]);
  // 显示口径：本次计数后的最新值；stat 行缺失（null）才退回读取时快照
  const clicksShown = clicksNow ?? video.clicks;

  const level = video.level as VideoLevel;
  const scores = videoScores(video.board3bv, video.realTime, level);
  // 标题成绩按级别配色（2026-10-13 张老师要求：初级绿 / 中级橙 / 高级金，与录像列表 hover 同色阶）
  const lvCls = LV_CLS[level] ?? "";
  // 棋盘空（RMV 旧上传没解析器，board 没落库）→ 从文件现解析兜底并回写库。
  // 与 metrics 缺行自愈同一思路；解析不出维持原样（棋盘不显示但页面不 500）。
  let board = video.board;
  if (!board) {
    board = (await ensureVideoBoard(video.id)) ?? "";
  }
  // 2026-10-14 张老师需求：本局六维表现雷达。10-16 张老师改定：待审只是合法性待确认，
  // 不应影响录像分析——屏蔽（status=0）才不显示
  const analysis =
    video.status !== VIDEO_STATUS.BANNED
      ? await getVideoAnalysis({
          id: video.id,
          level,
          noflag: video.noflag,
          bbbv: video.board3bv,
          realTime: video.realTime,
          filepath: video.filepath,
        })
      : null;
  // 评级问号气泡文案（2026-10-31 张老师定稿句；同日「稀有程度」更名「竞技水准」）：评级规则总述。
  const ratingHelpTip =
    "所有级别、NF和FL录像分开评；竞技水准取Time/3BVs/STNB中最强评级；路线规划在3BV相近的录像中横向评比；最终评级以竞技水准为主，五轴评分加权得出。";

  // ---------- 「个人发挥」板块（2026-11-05 张老师需求） ----------
  // 右栏「录像评级」下方：三根绿色进度条＝本局 Time / 3BV/s / STNB 与录像作者
  // 个人最好成绩之比。Time 反比（最好/本局），3BV/s、STNB 正比（本局/最好）。
  // 置灰口径与标题区 del 划线完全一致：运气盘（noRecord）划掉 Time/3BV/s/STNB，
  // 3BV 低于 MIN_3BV_FOR_3BVS 划掉 3BV/s/STNB——被划掉项进度条置灰且固定填满，
  // 右侧比例换「无效」（2026-11-05 张老师定）。
  // NF/FL 分池比较（getVideoPerformance 内处理）；作者该级该模式无最好成绩的项整行不渲染。
  const perf = video.author
    ? await getVideoPerformance(video.author.id, level, video.noflag)
    : null;
  const perfValid3bvs =
    !video.noRecord && video.board3bv >= MIN_3BV_FOR_3BVS[level] && scores["3bvs"] > 0;
  const perfValidStnb =
    video.stnb != null && video.stnb > 0 &&
    !video.noRecord && video.board3bv >= MIN_3BV_FOR_3BVS[level];
  const perfPct = (ratio: number) => {
    const p = ratio * 100;
    return (p >= 99.95 && p < 100.05 ? 100 : Math.round(p * 10) / 10).toFixed(1);
  };
  const perfRows: {
    key: string;
    ratio: number;
    off: boolean;
    cur: string;
    best: string;
  }[] = [];
  if (perf) {
    if (perf.time != null && video.realTime > 0) {
      perfRows.push({
        key: "Time",
        ratio: perf.time / video.realTime,
        off: !!video.noRecord,
        cur: scoreTime(video.realTime),
        best: scoreTime(perf.time),
      });
    }
    if (perf.bvs != null) {
      perfRows.push({
        key: "3BV/s",
        ratio: scores["3bvs"] / perf.bvs,
        off: !perfValid3bvs,
        cur: score3bvs(Math.abs(scores["3bvs"])),
        best: score3bvs(perf.bvs),
      });
    }
    if (perf.stnb != null && video.stnb != null && video.stnb > 0) {
      perfRows.push({
        key: "STNB",
        ratio: video.stnb / perf.stnb,
        off: !perfValidStnb,
        cur: video.stnb.toFixed(1),
        best: perf.stnb.toFixed(1),
      });
    }
  }
  // 气泡「个人最佳」文案（2026-11-05 张老师定）：NF 录像比 NF 最好 →「个人最佳NF纪录」，
  // FL 录像 →「个人最佳纪录」
  const perfBestLabel = video.noflag ? "个人最佳NF纪录" : "个人最佳纪录";
  // 录像评级盒内容（2026-11-01 张老师需求：≤880 单列带侧栏整组 display:none，
  // 评级雷达改在录像主体板块下面显示——与用户主页「实力」雷达换位同模式：
  // 主栏副本 .radar_main 桌面 display:none，侧栏原件 ≥881 照旧；同一 JSX 两处渲染，
  // VideoAnalysisRadar 多实例安全（clipId 用 useId，globals.css 同源作用域自动复用））
  const radarInner = analysis ? (
    <>
      {/* 标题行（2026-10-15 张老师定）：左＝「录像评级」，右＝本局**综合评级**
          （五轴分位加权，与练习页结算面板同一个算法，见 lib/videoscore.ts performanceOf）。
          2026-10-30 张老师定：问号紧靠标题文字（vr_h 是 space-between，文字与问号
          必须包进同一左组 span，否则问号会被推到行中） */}
      <h2 className="vr_h">
        <span className="vr_h_left">
          录像评级
          {/* 问号圆圈图标（2026-10-30，与首页每日一星同款 star_help）：hover 讲清
              评级规则（NF/FL 分池 + 3BV 相关参数按相近 3BV 分桶比） */}
          <span className="star_help" data-tip={ratingHelpTip}>
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="10" cy="10" r="8.4" />
              <path d="M7.6 8a2.5 2.5 0 1 1 3.4 2.33c-.7.28-1 .77-1 1.47v.3" strokeLinecap="round" />
              <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </span>
        </span>
        <span className="vr_rate" style={{ color: gradeColor(analysis.overall) }}>
          {analysis.overall}
        </span>
      </h2>
      <div className="vr_line" />
      <VideoAnalysisRadar data={analysis.points} />
    </>
  ) : null;

  return (
    <VideoReplayProvider
      boardId={video.id}
      filepath={video.filepath}
      fileVer={video.fileVer}
      realTimeMs={video.realTime}
      radarPoints={analysis?.points}
      radarOverall={analysis?.overall}
      radarDists={analysis?.dists}
      radarPoolDesc={analysis?.poolDesc}
      radarBppBucketPrefix={analysis?.bppBucketPrefix}
      level={level}
      noflag={video.noflag}
      boardStr={board}
    >
    <div id="page" className="two_columns">
    <ul id="video_view">
      <li className="main">
        <div className="video_cell box">
          {/* 术语 hover 说明气泡（2026-11-02 张老师需求：新手向解释 NF/3BV/3BV/s/STNB；
              文案在 config.ts TERM_*_TIP。data-tip 只挂术语文字（.term），不挂整个成绩
              span——无效成绩时 del 自带的「不承认」气泡不能被整 span 气泡连带触发重叠 */}
          <h1>
            {LEVEL_NAMES[level] ?? video.level}
            {/* 运气盘（noRecord，2026-11-02 张老师定）：时间成绩同 3BV/s/STNB 划线不承认 */}
            {video.noRecord ? (
              <del data-tip={INVALID_TIME_TIP} aria-label={INVALID_TIME_TIP}>
                <em className={lvCls}>{scoreTime(scores.time)}</em>秒
              </del>
            ) : (
              <em className={lvCls}>{scoreTime(scores.time)}</em>
            )}
            {video.noflag && <ins data-tip={TERM_NF_TIP}>NF</ins>}
          </h1>
          <h2>
            <span className="board_3bv">
              <span className="term" data-tip={TERM_3BV_TIP}>3BV</span>
              <em>{video.board3bv}</em>
            </span>
            <span className="score_3bvs">
              <span className="term" data-tip={TERM_3BVS_TIP}>3BV/s</span>
              {scores["3bvs"] > 0 && !video.noRecord ? (
                <em>{score3bvs(scores["3bvs"])}</em>
              ) : (
                // 无效成绩：hover 弹自定义气泡说明原因（2026-10-13 张老师要求，
                // 原生 title 有 1s 延迟且是系统灰样式，故走 data-tip）；
                // 运气盘即使 3BV/s 值达标也整个划线（2026-11-02）
                <del data-tip={INVALID_3BVS_TIP} aria-label={INVALID_3BVS_TIP}>
                  {score3bvs(Math.abs(scores["3bvs"]))}
                </del>
              )}
            </span>
            {/* 2026-10-30 张老师需求：3BV/s 右侧显示 STNB（video_metrics.stnb，与列表
                STNB 列/雷达判雷轴同源）；运气盘划线与 3BV/s 同口径（MIN_3BV_FOR_3BVS，
                初 10 / 中 4 / 高 4）——低于限界 del 划掉 + INVALID_STNB_TIP 气泡。
                无指标行（rmv 旧盘等）不渲染整个 span，与右栏雷达盒「无基准不渲染」同思路 */}
            {video.stnb != null && video.stnb > 0 && (
              <span className="score_stnb">
                <span className="term" data-tip={TERM_STNB_TIP}>STNB</span>
                {video.board3bv >= MIN_3BV_FOR_3BVS[level] && !video.noRecord ? (
                  <em>{video.stnb.toFixed(1)}</em>
                ) : (
                  <del data-tip={INVALID_STNB_TIP} aria-label={INVALID_STNB_TIP}>
                    {video.stnb.toFixed(1)}
                  </del>
                )}
              </span>
            )}
          </h2>
          {/* .info 只包棋盘（float 收缩宽）：meta 区/横线曾在其内部，右缘跟着
              盘面宽度走（初级盘缩到 726、高级盘溢出到 884），无法与成绩行
              STNB 右缘（恒 863）对齐——2026-11-05 张老师定搬出（见下条注释） */}
          <div className="info">
            <VideoReplayBoard id={video.id} level={level} board={board} />
          </div>
          {/* meta 区（2026-11-05 张老师需求定稿）：grid 两列三行——左列固定三行
              （作者/上传、审核/状态、软件/签名；p 原是 inline-block 收缩宽，名字短时
              行2行3会挤上同排，grid 化后各占一行固定），右列浏览/评论/下载各一行、
              与左列逐行对齐、右对齐。clear:both 落到棋盘浮层之下、拿满 cell 内容盒宽
              （右缘 871），再让 8px（同 STNB span 的 margin-right）→ 右缘 863 与
              STNB 右边缘齐平，不随盘面宽窄漂移 */}
          <div className="meta_area">
              <p className="meta">
                {video.author && (
                  <>
                    <AvatarCell id={video.author.id} name={video.author.chineseName} englishName={video.author.englishName} sex={video.author.sex} className="author" link />
                    <TitleBadge title={video.authorTitle} classic={video.authorClassic} link />
                  </>
                )}
                <span className="create_time">
                  上传于<em><RelTime time={video.createTime} /></em>
                </span>
              </p>
              <span className="counters">
                <em>{clicksShown}</em>次浏览
              </span>
              <p>
                {video.reviewer && video.reviewTime && (
                  <>
                    <Link href={`/user/${video.reviewer.id}`} className="avatar_link reviewer" target="_blank" prefetch={false}>
                      {video.reviewer.chineseName}
                      <span className="pt_bubble">
                        <PlayerTip id={video.reviewer.id} name={video.reviewer.chineseName} englishName={video.reviewer.englishName} />
                      </span>
                    </Link>
                    <span className="review_time">
                      审核于<em><RelTime time={video.reviewTime} /></em>
                    </span>
                  </>
                )}
                {/* 2026-10-23 张老师需求：已通过（st20）文字后放 ✓（继承 st20 绿）；
                    待审核（st10）橙色显示（globals.css 提权覆盖 legacy 绿） */}
                <span className={`status st${video.status}`}>
                  {VIDEO_STATUS_NAMES[video.status] ?? video.status}
                  {video.status === VIDEO_STATUS.REVIEWED && <em className="ok">✓</em>}
                </span>
              </p>
              <span className="counters">
                <em>{video.comments}</em>条评论
              </span>
              <p>
                {/* 2026-10-29 张老师需求：软件名前加原色图标（列表页灰度、详情页原色） */}
                <span className="software">
                  软件
                  <SoftwareIcon software={video.software} version={video.version} detail />
                  <em>{video.software} {video.version}</em>
                </span>
                <span className="signature">
                  签名<em>{video.signature}</em>
                </span>
              </p>
              <span className="counters">
                <em>{video.downloads}</em>次下载
              </span>
            </div>
            <hr />
            <VideoReplayButton />
            <a className="button" href={`/video/download/${video.id}`}>
              <svg className="btn_icon" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 2v9.6" />
                <path d="M4.9 8 9 12.1 13.1 8" />
                <path d="M2.4 14.8h13.2" />
              </svg>
              下载
            </a>
            {/* 本人可在下载按钮旁删除自己的待审/屏蔽录像；已通过录像不开放自助删除。
                确认后连带清理评论/引用动态，跳回个人主页。 */}
            {(video.status === VIDEO_STATUS.NORMAL || video.status === VIDEO_STATUS.BANNED) &&
              session && session.uid === video.author?.id && (
                <VideoSelfDeleteButton videoId={video.id} userId={session.uid} />
              )}
        </div>
        {/* 2026-11-01 张老师需求：≤880 单列带把侧栏整组隐藏（评级雷达连带消失），
            主栏这份副本在录像主体板块下、评论区上亮起（桌面 display:none，
            globals.css #video_view .radar_main 组；同一 radarInner 两处渲染） */}
        {radarInner && (
          <div className="radar box radar_main">{radarInner}</div>
        )}
        {/* 2026-10-22：评论区收拢为客户端壳——发表后就地插入列表头（张老师要求：
            评论发出后立刻可见，不管有没有过审；本人待审行查询层按登录态放行）
            2026-10-26：新增删除权限——发布者本人可删自己的评论、录像作者可删他人评论
            （videoOwnerId 供前端判定，服务端 /api/comment/delete 铁闸同口径） */}
        <CommentSection
          videoId={video.id}
          videoOwnerId={video.author?.id ?? 0}
          authorId={session?.uid ?? 0}
          isManager={!!session && isManager(session.role)}
          initial={comments}
          initialHasMore={comments.length < commentTotal}
          initialTotal={commentTotal}
          anchorComment={anchorComment}
        />
      </li>
      <li className="sidebar">
        {/* 2026-10-13 六轮：右栏由「名字 + 军衔」小盒换成与论坛右栏同款个人卡片 + 实力雷达图
            （卡片展示录像上传者；审稿人信息仍在正文区不动）
            2026-10-14：实力雷达下线（hideRadar），下方改挂本局的「录像分析」六维雷达 */}
        {video.author && <UserPanel userId={video.author.id} hideRadar />}
        {radarInner && (
          <div className="radar box">{radarInner}</div>
        )}
        {/* 「个人发挥」（2026-11-05 张老师需求）：三根绿色进度条＝本局成绩与作者
            个人最好成绩之比（Time 反比最好/本局，3BV/s、STNB 正比本局/最好）。
            行 hover 出气泡「xx = 当前值 个人最佳(NF)纪录 y」（后者元帅金 #e6db74）；
            被划线成绩（运气盘 / 3BV 低于限界）进度条置灰。仅桌面右栏（≤880 侧栏
            整组隐藏，如需移动端副本照 radar_main 模式另行挂） */}
        {perfRows.length > 0 && (
          <div className="perf box">
            {/* 标题无问号（2026-11-05 张老师定：疑义不多） */}
            <h2 className="vr_h">
              <span className="vr_h_left">个人发挥</span>
            </h2>
            <div className="vr_line" />
            {perfRows.map((r) => {
              const pct = Math.round(r.ratio * 1000) / 10;
              // 置灰行（划线成绩）不按比例：条固定填满，右侧比例换「无效」（2026-11-05 张老师定）
              const width = r.off ? 100 : Math.min(100, Math.max(0, pct));
              // 100% 行：进度条右侧的百分比换成金 PB 标签（2026-11-05 张老师需求，
              // 样式复刻排行模式数据面板 .pb_badge）；口径与百分比显示一致
              // （99.95–100.05 视作 100，见 perfPct）；置灰行不发牌
              const pb = !r.off && perfPct(r.ratio) === "100.0";
              return (
                <div className={`perf_row${r.off ? " off" : ""}`} key={r.key}>
                  <span className="perf_label">{r.key}</span>
                  <span className="perf_bar">
                    <em style={{ width: `${width}%` }} />
                  </span>
                  <span className="perf_pct">
                    {pb ? <i className="pb_badge">PB</i> : r.off ? "无效" : `${perfPct(r.ratio)}%`}
                  </span>
                  <span className="perf_tip">
                    {r.key} = {r.off ? <s className="perf_tip_cur">{r.cur}</s> : r.cur}
                    <b>{perfBestLabel} {r.best}</b>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </li>
    </ul>
    </div>
    </VideoReplayProvider>
  );
}
