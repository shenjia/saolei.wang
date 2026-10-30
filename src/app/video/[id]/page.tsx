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
  LEVEL_NAMES,
  MIN_3BV_FOR_3BVS,
  VIDEO_STATUS_NAMES,
  isManager,
  type VideoLevel,
} from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { AvatarCell, PlayerTip, TitleBadge } from "@/components/Cells";
import { SoftwareIcon } from "@/components/VideoRows";
import { UserPanel } from "@/components/UserCard";
import { CommentSection } from "@/components/Comments";
// 原地回放（2026-10-15 张老师需求：点播放后棋盘原地重演，复用练习页回放引擎；
// rmv/解析失败自动兜底 flop 全屏播放器——FlopPlayer 由 VideoReplayProvider 按需挂）
import { VideoReplayProvider, VideoReplayBoard, VideoReplayButton } from "@/components/VideoReplay";
import { VideoSelfDeleteButton } from "@/components/VideoSelfDeleteButton";
import { VideoAnalysisRadar } from "@/components/VideoAnalysis";
import { getVideoAnalysis } from "@/lib/videoanalysis";
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
  const [comments, commentTotal] = await Promise.all([
    getComments(videoId, 0, COMMENT_TOP_NUMBER, session?.uid ?? null),
    // 评论总数（「加载更多」括号内剩余条数口径，按实际行数而非 video_stat 冗余计数）
    getCommentsCount(videoId, session?.uid ?? null),
    // 点击计数（移植 actionView 的 uniqueAction('click')）
    (async () => uniqueVideoAction(videoId, "click", clientIp(await headers())))(),
  ]);

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
  // 评级问号气泡文案（2026-10-30 张老师需求，原句口径）：「在高级3bv在160-179的
  // 所有NF录像中进行评比」——讲清实际比对的「级别 × 3BV 粗桶 × 模式」；桶行缺样本
  // 回退整组（bucketRange=null，如极端 3BV 段或自定义盘）时不带 3BV 区间从句。
  // 站内习惯口径（OnlinePlay）：NF 打法不写「标雷」，直接省略模式词。
  const ratingHelpTip = analysis
    ? analysis.bucketRange
      ? `在${LEVEL_NAMES[level] ?? video.level}3bv在${analysis.bucketRange}的所有${video.noflag ? "NF" : ""}录像中进行评比。`
      : `在${LEVEL_NAMES[level] ?? video.level}的所有${video.noflag ? "NF" : ""}录像中进行评比。`
    : "";

  return (
    <VideoReplayProvider
      boardId={video.id}
      filepath={video.filepath}
      realTimeMs={video.realTime}
      radarPoints={analysis?.points}
      radarOverall={analysis?.overall}
      radarDists={analysis?.dists}
      level={level}
      noflag={video.noflag}
      boardStr={board}
    >
    <div id="page" className="two_columns">
    <ul id="video_view">
      <li className="main">
        <div className="video_cell box">
          <h1>
            {LEVEL_NAMES[level] ?? video.level}
            <em className={lvCls}>{scoreTime(scores.time)}</em>秒 {video.noflag && <ins>NF</ins>}
          </h1>
          <h2>
            <span className="board_3bv">
              3BV<em>{video.board3bv}</em>
            </span>
            <span className="score_3bvs">
              3BV/s
              {scores["3bvs"] > 0 ? (
                <em>{score3bvs(scores["3bvs"])}</em>
              ) : (
                // 无效成绩：hover 弹自定义气泡说明原因（2026-10-13 张老师要求，
                // 原生 title 有 1s 延迟且是系统灰样式，故走 data-tip）
                <del data-tip={INVALID_3BVS_TIP} aria-label={INVALID_3BVS_TIP}>
                  {score3bvs(-scores["3bvs"])}
                </del>
              )}
            </span>
            {/* 2026-10-30 张老师需求：3BV/s 右侧显示 STNB（video_metrics.stnb，与列表
                STNB 列/雷达判雷轴同源）；运气盘划线与 3BV/s 同口径（MIN_3BV_FOR_3BVS，
                初 10 / 中 4 / 高 4）——低于限界 del 划掉 + INVALID_STNB_TIP 气泡。
                无指标行（rmv 旧盘等）不渲染整个 span，与右栏雷达盒「无基准不渲染」同思路 */}
            {video.stnb != null && video.stnb > 0 && (
              <span className="score_stnb">
                STNB
                {video.board3bv >= MIN_3BV_FOR_3BVS[level] ? (
                  <em>{video.stnb.toFixed(1)}</em>
                ) : (
                  <del data-tip={INVALID_STNB_TIP} aria-label={INVALID_STNB_TIP}>
                    {video.stnb.toFixed(1)}
                  </del>
                )}
              </span>
            )}
          </h2>
          <div className="info">
            <VideoReplayBoard id={video.id} level={level} board={board} />
            <p>
              {video.author && (
                <>
                  <AvatarCell id={video.author.id} name={video.author.chineseName} englishName={video.author.englishName} sex={video.author.sex} className="author" link />
                  <TitleBadge title={video.authorTitle} classic={video.authorClassic} link />
                </>
              )}
              <span className="create_time">
                上传于<em>{timeOpposite(video.createTime)}</em>
              </span>
            </p>
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
                    审核于<em>{timeOpposite(video.reviewTime)}</em>
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
            <p className="counters">
              <span className="clicks">
                点击<em>{video.clicks}</em>
              </span>
              <span className="comments">
                评论<em>{video.comments}</em>
              </span>
              <span className="downloads">
                下载<em>{video.downloads}</em>
              </span>
            </p>
          </div>
        </div>
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
        {analysis && (
          <div className="radar box">
            {/* 标题行（2026-10-15 张老师定）：左＝「录像评级」，右＝本局**综合评级**
                （五轴组内分位加权，STNB 占一半 —— 与练习页结算面板「评级：S+」同一个算法，
                见 lib/videoscore.ts performanceOf）；标题下一条分割线与雷达图分开 */}
            <h2 className="vr_h">
              录像评级
              {/* 问号圆圈图标（2026-10-30 张老师需求，与首页每日一星同款 star_help）：
                  hover 讲清评级的**比对桶**——实际命中的「级别 × 模式 × 3BV 粗桶」，
                  桶行缺样本回退整组（bucketRange=null）时不带 3BV 限定 */}
              <span className="star_help" data-tip={ratingHelpTip}>
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <circle cx="10" cy="10" r="8.4" />
                  <path d="M7.6 8a2.5 2.5 0 1 1 3.4 2.33c-.7.28-1 .77-1 1.47v.3" strokeLinecap="round" />
                  <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
                </svg>
              </span>
              <span className="vr_rate" style={{ color: gradeColor(analysis.overall) }}>
                {analysis.overall}
              </span>
            </h2>
            <div className="vr_line" />
            <VideoAnalysisRadar data={analysis.points} />
          </div>
        )}
      </li>
    </ul>
    </div>
    </VideoReplayProvider>
  );
}
