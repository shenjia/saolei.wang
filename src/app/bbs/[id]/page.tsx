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
import { UserCard } from "@/components/UserCard";
import { getUserCards } from "@/lib/usercard";

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
  // 每楼作者信息卡片（楼层的与右栏楼主的共用一份缓存）
  const cards = await getUserCards(
    [post.author?.id ?? 0, ...replies.map((r) => r.author?.id ?? 0)].filter((x) => x > 0)
  );

  return (
    <div id="page" className="two_columns">
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
              {post.isPinned && (
                <span className="bbs_top" data-tip="置顶">
                  ▲
                </span>
              )}
              {post.isTop && (
                <span className="bbs_high_flag" data-tip="高亮">
                  ◆
                </span>
              )}
            </h1>
            <p className="bbs_meta">
              {post.author && (
                <>
                  <AvatarCell id={post.author.id} name={post.author.chineseName} sex={post.author.sex} link />{" "}
                  <TitleBadge title={post.author.title} link />{" "}
                </>
              )}
              发表于 {timeOpposite(post.createTime, TIME_NEVER)}　点击 <em>{post.clicks}</em>　回复{" "}
              <em>{post.replies}</em>
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
                    <AvatarCell id={r.author.id} name={r.author.chineseName} sex={r.author.sex} link />{" "}
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
              <p className="text">
                <LoginLink>登录</LoginLink> 后才能回复。
              </p>
            )}
          </div>
        </li>
        <li className="sidebar">
          {post.author && cards.get(post.author.id) && (
            <div id="bbs_op_card" className="box">
              <UserCard
                card={cards.get(post.author.id)!}
                own={session?.uid === post.author.id}
                side
              />
            </div>
          )}
        </li>
      </ul>
    </div>
  );
}
