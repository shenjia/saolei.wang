// 主题详情（移植 2008 版 BBS/Title.asp：点击计数、回复楼层流、操作按钮）
// 布局（2026-09-23 张老师要求）：页面级双栏——左列帖子楼层流，右列楼主卡片独立板块
// 楼层流（2026-10-13 张老师要求）：由「翻页」改「加载更多」——首屏取第一批交 BbsReplySection，
//   后续批次走 /api/bbs/reply/more（cursor 语义），?page= 深链作废
// 2026-10-22 张老师要求：多条评论支持滑动分页——升级全站通用 PageSlider 页码滑条
//   （BbsReplies 内部走页码模式 /api/bbs/reply/more?page=N；首屏仍服务端渲染第一页）

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARD_NAMES, BBS_REPLY_PAGESIZE, getPost, getReplyFeed, locateReply, ubb } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER, decodeLegacyEntities } from "@/lib/format";
import { PostOps } from "@/components/BbsOps";
import { BbsReplySection } from "@/components/BbsReplies";
import { BbsAuthorName, TitleBadge } from "@/components/Cells";
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
    where: { id: BigInt(postId), status: { in: [0, 5] } },
    select: { title: true, board: true },
  });
  if (!p) return {};
  const board = BBS_BOARD_NAMES[p.board];
  // 老 ASP 实体解码（2026-10-15，同页面 h1 口径；此处独立直查不走 getPost）
  return { title: `${board ? `【${board}】` : ""}${decodeLegacyEntities(p.title)}` };
}

export default async function BbsTitlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const postId = parseInt(id, 10) || 0;

  // 2026-10-22 张老师要求：文章/评论发出后不管过没过审，发表者本人必须一直看得到。
  // 取数带 includePending（待审主题不 404），取回后再按视角拦截：待审主题仅作者本人/管理员可见。
  const session = await getSession();
  const admin = session ? isManager(session.role) : false;

  // 2026-10-22 张老师要求：评论动态/消息通知链接要能定位到具体评论——
  // ?reply=<回复id>：服务端定位该楼层所在页（页码口径同翻页滑条），首屏直接 SSR 该页，
  // 客户端挂载后滚到 #reply-<id> 锚点并高亮；目标已删则回退第一页（链接仍落到文章）
  const sp = await searchParams;
  const anchorReply = parseInt(sp.reply ?? "", 10) || 0;
  let startPage = 1;
  if (anchorReply) {
    const loc = await locateReply(anchorReply, session?.uid ?? null);
    if (loc && loc.post === postId) startPage = loc.page;
  }

  const post = await getPost(postId, true, true);
  if (!post) notFound();
  // 2026-10-27 张老师定：过敏感词即公开、AI/人审一律后置——待审主题（5）不再对非作者 404；
  // 「审核中」徽章仅作者本人/管理员视角渲染
  // 楼层流同口径：本人待审楼层（status=5）一并带出（渲染「审核中」徽章）
  const { items: replies, total: replyTotal } = await getReplyFeed(
    postId,
    0,
    BBS_REPLY_PAGESIZE,
    session?.uid ?? null,
    startPage > 1 ? startPage : undefined
  );

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
              {/* 2026-10-27：待审主题对所有人可见；「审核中」徽章仅作者本人/管理员视角渲染 */}
              {post.status === 5 && (admin || session?.uid === post.author?.id) && (
                <span className="review_pending" data-tip="文章已公开展示，AI 存疑转人工复核中">
                  审核中
                </span>
              )}
              {post.isNice && (
                <span className="bbs_star" data-tip="精华">
                  ★
                </span>
              )}
              {/* 2026-10-16（张老师）：恢复详情页置顶标记（09-26「详情页不显示」口径作废），
                  同列表页 .bbs_top ▲ + data-tip「置顶」hover 气泡，样式全局复用零新增 CSS */}
              {post.isPinned && (
                <span className="bbs_top" data-tip="置顶">
                  ▲
                </span>
              )}
            </h1>
            <p className="bbs_meta">
              {post.author && (
                <>
                  <BbsAuthorName
                    id={post.author.id}
                    name={post.author.chineseName}
                    englishName={post.author.englishName}
                    sex={post.author.sex}
                    avatar={post.author.avatar}
                  />{" "}
                  <TitleBadge title={post.author.title} classic={post.author.old} link />{" "}
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
                  flags={{ isPinned: post.isPinned, isNice: post.isNice, isLocked: post.isLocked }}
                />
              )}
            </p>
            <hr />
            <div className="bbs_content" dangerouslySetInnerHTML={{ __html: ubb(post.content) }} />
          </div>

          {/* 楼层流 + 「加载更多/页码滑条」+ 回复表单（同一客户端组件：回帖后就地接上新楼层）
              key=post.id：软导航切主题时强制重挂载，避免沿用上一个主题的已加载楼层
              initialPage/anchorReply（2026-10-22）：?reply= 深链首屏直接渲染目标页并定位锚点 */}
          <BbsReplySection
            key={post.id}
            postId={post.id}
            initial={replies}
            initialTotal={replyTotal}
            initialPage={startPage}
            anchorReply={anchorReply}
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
