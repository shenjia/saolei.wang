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
  LEVEL_NAMES,
  VIDEO_STATUS_NAMES,
  type VideoLevel,
} from "@/lib/config";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { UserPanel } from "@/components/UserCard";
import { LoginLink } from "@/components/LoginLink";
import { CommentForm, CommentList } from "@/components/Comments";
// 原地回放（2026-10-15 张老师需求：点播放后棋盘原地重演，复用练习页回放引擎；
// rmv/解析失败自动兜底 flop 全屏播放器——FlopPlayer 由 VideoReplayProvider 按需挂）
import { VideoReplayProvider, VideoReplayBoard, VideoReplayButton } from "@/components/VideoReplay";
import { VideoAnalysisRadar } from "@/components/VideoAnalysis";
import { getVideoAnalysis } from "@/lib/videoanalysis";
import { ensureVideoBoard } from "@/lib/videometrics";
// 综合评级的等级配色（与雷达图同一份，统一在 videoscore.ts 维护）
import { gradeColor } from "@/lib/videoscore";
import { VIDEO_STATUS } from "@/lib/config";

export const dynamic = "force-dynamic";

/** 级别 class（与录像列表 VideoRows 的 lv_* 口径一致） */
const LV_CLS: Record<string, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

export default async function VideoViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) notFound();

  const video = await getVideoDetail(videoId);
  if (!video) notFound();
  const [session, comments, commentTotal] = await Promise.all([
    getSession(),
    getComments(videoId, 0, COMMENT_TOP_NUMBER),
    // 评论总数（「加载更多」括号内剩余条数口径，按实际行数而非 video_stat 冗余计数）
    getCommentsCount(videoId),
    // 点击计数（移植 actionView 的 uniqueAction('click')）
    (async () => uniqueVideoAction(videoId, "click", clientIp(await headers())))(),
  ]);

  const scores = videoScores(video.board3bv, video.realTime);
  const level = video.level as VideoLevel;
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

  return (
    <VideoReplayProvider
      boardId={video.id}
      filepath={video.filepath}
      realTimeMs={video.realTime}
      radarPoints={analysis?.points}
      radarOverall={analysis?.overall}
      level={level}
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
          </h2>
          <div className="info">
            <VideoReplayBoard id={video.id} level={level} board={board} />
            <p>
              {video.author && (
                <>
                  <AvatarCell id={video.author.id} name={video.author.chineseName} sex={video.author.sex} className="author" link />
                  <TitleBadge title={video.authorTitle} link />
                </>
              )}
              <span className="create_time">
                上传于<em>{timeOpposite(video.createTime)}</em>
              </span>
            </p>
            <p>
              {video.reviewer && video.reviewTime && (
                <>
                  <Link href={`/user/${video.reviewer.id}`} className="avatar_link reviewer" target="_blank">
                    {video.reviewer.chineseName}
                  </Link>
                  <span className="review_time">
                    审核于<em>{timeOpposite(video.reviewTime)}</em>
                  </span>
                </>
              )}
              <span className={`status st${video.status}`}>
                {VIDEO_STATUS_NAMES[video.status] ?? video.status}
              </span>
            </p>
            <p>
              <span className="software">
                软件<em>{video.software} {video.version}</em>
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
        <CommentList
          videoId={video.id}
          initial={comments}
          initialHasMore={comments.length < commentTotal}
          initialTotal={commentTotal}
        />
        {/* 2026-10-13 张老师要求：底部加「发表评论」板块（参考论坛详情页底部的「回复主题」盒子）——
            盒子常驻：登录用户见输入框，未登录见「登录 后才能发表评论。」（点击弹全局登录浮窗） */}
        <div className="post box">
          <h2>发表评论</h2>
          {session ? (
            <CommentForm videoId={video.id} />
          ) : (
            <p className="text login_hint">
              <LoginLink>登录</LoginLink> 后才能发表评论。
            </p>
          )}
        </div>
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
