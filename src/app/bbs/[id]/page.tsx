// 主题详情（移植 2008 版 BBS/Title.asp：点击计数、回复分页、操作按钮）

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARD_NAMES, getPost, getReplies, ubb } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { PostOps, ReplyDelete, ReplyForm } from "@/components/BbsOps";

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
    <div id="page" className="main">
      <div className="box bbs_post">
        <h1>
          {post.isTop && <em className="bbs_flag">置顶</em>}
          {post.isNice && <em className="bbs_flag nice">精华</em>}【{BBS_BOARD_NAMES[post.board]}】
          {post.title}
        </h1>
        <p className="bbs_meta">
          {post.author && (
            <Link href={`/user/${post.author.id}`} target="_blank">
              {post.author.chineseName}
            </Link>
          )}{" "}
          发表于 {timeOpposite(post.createTime, TIME_NEVER)}　点击 <em>{post.clicks}</em>　回复{" "}
          <em>{post.replies}</em>
          {session && (
            <PostOps
              postId={post.id}
              isOwner={session.uid === post.author?.id}
              isAdmin={admin}
              flags={{ isTop: post.isTop, isNice: post.isNice, isLocked: post.isLocked }}
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
              <Link href={`/user/${r.author.id}`} target="_blank">
                {r.author.chineseName}
              </Link>
            )}{" "}
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
            <Link href="/account/login">登录</Link> 后才能回复。
          </p>
        )}
      </div>
    </div>
  );
}
