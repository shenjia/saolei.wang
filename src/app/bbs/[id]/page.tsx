// 主题详情（移植 2008 版 BBS/Title.asp：点击计数、回复楼层流、操作按钮）
// 布局（2026-09-23 张老师要求）：页面级双栏——左列帖子楼层流，右列楼主卡片独立板块
// 楼层流（2026-10-13 张老师要求）：由「翻页」改「加载更多」——首屏取第一批交 BbsReplySection，
//   后续批次走 /api/bbs/reply/more（cursor 语义），?page= 深链作废

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARD_NAMES, getPost, getReplyFeed, ubb } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { PostOps } from "@/components/BbsOps";
import { BbsReplySection } from "@/components/BbsReplies";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { UserPanel } from "@/components/UserCard";
import { BbsReadMark } from "@/components/BbsRead";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 页面标题（2026-10-13 张老师要求）：【分类】主题标题 | 扫雷网，
 * 与详情页 <h1>【分类】标题 的前缀口径一致。
 * 只取标题/板块两列（不联作者、不计数），避免与页面 getPost 的浏览计数重复叠加。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const postId = parseInt((await params).id, 10);
  if (!postId) return {};
  const p = await prisma.bbsPost.findFirst({
    where: { id: BigInt(postId), status: 0 },
    select: { title: true, board: true },
  });
  if (!p) return {};
  const board = BBS_BOARD_NAMES[p.board];
  return { title: `${board ? `【${board}】` : ""}${p.title}` };
}

export default async function BbsTitlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = parseInt(id, 10) || 0;

  const [post, session] = await Promise.all([getPost(postId), getSession()]);
  if (!post) notFound();
  const { items: replies, total: replyTotal } = await getReplyFeed(postId);
  const admin = session ? isManager(session.role) : false;

  return (
    <div id="page" className="two_columns">
      {/* 已读标记：进详情页即记录（列表页标题变灰，2026-09-26 张老师要求） */}
      <BbsReadMark id={post.id} />
      <ul id="home">
        <li className="main">
          <div className="box bbs_post">
            {/* 2026-10-14（张老师）：分类由【文字】改为 board_tag 徽章渲染，
                与论坛列表页/首页论坛新帖同款四板块配色（公告黄/技术绿/问答橙/杂谈灰） */}
            <h1>
              <span
                className={
                  "board_tag" +
                  (post.board === 0
                    ? " notice"
                    : post.board === 1
                      ? " tech"
                      : post.board === 3
                        ? " qa"
                        : "")
                }
              >
                {BBS_BOARD_NAMES[post.board]}
              </span>
              {post.title}
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

          {/* 楼层流 + 「加载更多」+ 回复表单（同一客户端组件：回帖后就地接上新楼层）
              key=post.id：软导航切主题时强制重挂载，避免沿用上一个主题的已加载楼层 */}
          <BbsReplySection
            key={post.id}
            postId={post.id}
            initial={replies}
            initialTotal={replyTotal}
            canReply={!!session}
            locked={post.isLocked && !admin}
            viewerUid={session?.uid ?? null}
            postAuthorId={post.author?.id ?? null}
            isAdmin={admin}
          />
        </li>
        <li className="sidebar">
          {/* 右栏楼主个人卡片 + 实力雷达图（2026-10-13 六轮：与录像详情页共用同一面板组件） */}
          {post.author && <UserPanel userId={post.author.id} cardId="bbs_op_card" />}
        </li>
      </ul>
    </div>
  );
}
