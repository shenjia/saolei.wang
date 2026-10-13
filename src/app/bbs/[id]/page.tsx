// 主题详情（移植 2008 版 BBS/Title.asp：点击计数、回复分页、操作按钮）
// 布局（2026-09-23 张老师要求）：页面级双栏——左列帖子楼层流，右列楼主卡片独立板块

import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARD_NAMES, getPost, getReplies, ubb } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { LoginLink } from "@/components/LoginLink";
import { PostOps, ReplyDelete, ReplyForm } from "@/components/BbsOps";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { UserPanel } from "@/components/UserCard";
import { BbsReadMark } from "@/components/BbsRead";

export const dynamic = "force-dynamic";

export default async function BbsTitlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const postId = parseInt(id, 10) || 0;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [post, session] = await Promise.all([getPost(postId), getSession()]);
  if (!post) notFound();
  const { replies, total, pageSize } = await getReplies(postId, page);
  const admin = session ? isManager(session.role) : false;

  return (
    <div id="page" className="two_columns">
      {/* 已读标记：进详情页即记录（列表页标题变灰，2026-09-26 张老师要求） */}
      <BbsReadMark id={post.id} />
      <ul id="home">
        <li className="main">
          <div className="box bbs_post">
            <h1>
              【{BBS_BOARD_NAMES[post.board]}】{post.title}
              {post.isNice && (
                <span className="bbs_star" data-tip="精华">
                  ★
                </span>
              )}
              {/* 2026-09-26（张老师）：详情页标题后不再显示置顶▲/高亮◆标记，列表页保留 */}
            </h1>
            <p className="bbs_meta">
              {post.author && (
                <>
                  <AvatarCell id={post.author.id} name={post.author.chineseName} sex={post.author.sex} gender="small" link />{" "}
                  <TitleBadge title={post.author.title} link />{" "}
                </>
              )}
              发表于 {timeOpposite(post.createTime, TIME_NEVER)}　
              <span className="bbs_count">
                {post.clicks}{" "}
                <span className="bbs_count_unit">次浏览</span>{" "}
                {post.replies}{" "}
                <span className="bbs_count_unit">条评论</span>
              </span>
              {session && (
                <PostOps
                  postId={post.id}
                  isOwner={session.uid === post.author?.id}
                  isAdmin={admin}
                  notice={post.board === 0}
                  flags={{ isTop: post.isTop, isPinned: post.isPinned, isNice: post.isNice, isLocked: post.isLocked }}
                />
              )}
            </p>
            <hr />
            <div className="bbs_content" dangerouslySetInnerHTML={{ __html: ubb(post.content) }} />
          </div>

          {replies.map((r) => (
            <div key={r.id} className="box bbs_post">
              <p className="bbs_meta">
                <em>{r.floor} 楼</em>{" "}
                {r.author && (
                  <>
                    <AvatarCell id={r.author.id} name={r.author.chineseName} sex={r.author.sex} gender="small" link />{" "}
                    <TitleBadge title={r.author.title} link />{" "}
                  </>
                )}
                {timeOpposite(r.createTime, TIME_NEVER)}
                {session && (admin || session.uid === r.author?.id || session.uid === post.author?.id) && (
                  <span className="bbs_ops">
                    {" "}
                    <ReplyDelete replyId={r.id} />
                  </span>
                )}
              </p>
              <div className="bbs_content" dangerouslySetInnerHTML={{ __html: ubb(r.content) }} />
            </div>
          ))}
          <Pager base={`/bbs/${post.id}`} params={{}} page={page} total={total} pageSize={pageSize} />

          <div className="box">
            <h2>回复主题</h2>
            {session ? (
              <ReplyForm postId={post.id} locked={post.isLocked && !admin} />
            ) : (
              <p className="text login_hint">
                <LoginLink>登录</LoginLink> 后才能回复。
              </p>
            )}
          </div>
        </li>
        <li className="sidebar">
          {/* 右栏楼主个人卡片 + 实力雷达图（2026-10-13 六轮：与录像详情页共用同一面板组件） */}
          {post.author && <UserPanel userId={post.author.id} cardId="bbs_op_card" />}
        </li>
      </ul>
    </div>
  );
}
