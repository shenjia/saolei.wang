// BBS API：发帖/编辑/删除/回帖/删回复/管理操作
import { NextRequest, NextResponse, after } from "next/server";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { prisma } from "@/lib/db";
import { runContentReview } from "@/lib/content-review";
import { sendMessage } from "@/lib/message";
import { decodeLegacyEntities } from "@/lib/format";
import {
  adminSetPost,
  BBS_BOARD_NAMES,
  BBS_CONTENT_LIMIT,
  BBS_TITLE_LIMIT,
  canPost,
  createPost,
  createReply,
  deletePost,
  deleteReply,
  updatePost,
} from "@/lib/bbs";
import {
  checkSensitive,
  checkSensitiveAll,
  logSensitiveHit,
  sensitiveRejectMessage,
  type SensitiveResult,
} from "@/lib/sensitive";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function POST(req: NextRequest) {
  // 维护模式：挡产生新内容/新楼层的入口（post/reply/edit）；delete/admin 是收敛操作，放行
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  if (["post", "reply", "edit"].includes(action) && (await isMaintenanceOn())) {
    return maintenanceReject() as unknown as NextResponse;
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const admin = isManager(session.role);

  const id = parseInt(String(body.id ?? ""), 10) || 0;

  // 敏感词命中的统一拒绝出口（2026-10-13）：不落库、不发动态，只回提示文案（不暴露具体词）
  const reject = (result: SensitiveResult, scope: string) => {
    logSensitiveHit(scope, session.uid, result);
    return NextResponse.json({ error: sensitiveRejectMessage(result) }, { status: 400 });
  };

  if (action === "post") {
    const board = parseInt(String(body.board ?? ""), 10);
    const title = String(body.title ?? "").trim().slice(0, BBS_TITLE_LIMIT);
    const content = String(body.content ?? "").trim().slice(0, BBS_CONTENT_LIMIT);
    if (!(board in BBS_BOARD_NAMES)) return NextResponse.json({ error: "板块不存在" }, { status: 400 });
    if (board === 0 && !admin) return NextResponse.json({ error: "公告板块仅管理员可发" }, { status: 403 });
    if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    if (!admin && !(await canPost(session.uid))) {
      return NextResponse.json({ error: "加入排行后才能发布主题" }, { status: 403 });
    }
    const hit = checkSensitiveAll([title, content]);
    if (!hit.ok) return reject(hit, "bbs.post");
    const postId = await createPost(session.uid, board, title, content);
    // AI 后置复审（2026-10-13）：标题 + 正文合并送审
    after(() => runContentReview("bbs_post", postId, `${title}\n${content}`));
    return NextResponse.json({ id: postId });
  }

  if (action === "reply") {
    const content = String(body.content ?? "").trim().slice(0, BBS_CONTENT_LIMIT);
    // 被回复楼层 id（2026-10-15 评论回复）：「回复」链接带入，引用头由服务端拼装
    const replyTo = parseInt(String(body.replyTo ?? ""), 10) || 0;
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    if (!admin && !(await canPost(session.uid))) {
      return NextResponse.json({ error: "加入排行后才能回复" }, { status: 403 });
    }
    const hit = checkSensitive(content);
    if (!hit.ok) return reject(hit, "bbs.reply");
    const r = await createReply(id, session.uid, content, admin, replyTo);
    if (r === "locked") return NextResponse.json({ error: "主题已锁定" }, { status: 403 });
    if (r === null) return NextResponse.json({ error: "主题不存在" }, { status: 404 });
    const replyId = r.id;
    // 评论通知（2026-10-15 张老师要求，落库成功后才发；消息 200 字限长在 sendMessage 内天然截断风险：
    // 标题最长 100 + 模板约 30，标记占位 <40，总长可控）：《标题》内嵌 [url /bbs/N]…[/url] 可点击跳文章页
    const post = await prisma.bbsPost.findUnique({
      where: { id: BigInt(id) },
      select: { title: true, user: true },
    });
    if (post) {
      const postTitle = decodeLegacyEntities(post.title);
      // 2026-10-22 张老师要求：消息里的链接直达该条评论——?reply=<回复id> 由详情页
      // 定位到楼层所在页并锚点滚动（MSG_LINK_RE 的 path 段含 ?/#，query 天然可解析）
      const titleLink = `[url /bbs/${id}?reply=${replyId}#reply-${replyId}]《${postTitle}》[/url]`;
      // ① 回复了别人的评论 → 通知被回复者
      if (r.quotedUserId) {
        await sendMessage(session.uid, r.quotedUserId, `我回复了你在${titleLink}文章中的评论`);
      }
      // ② 任何评论 → 通知楼主（自评不发；被回复者就是楼主时 ① 已通知，不再重复发——
      // 2026-10-22 张老师反馈：楼主收到「回复评论」+「评论文章」两条重复短信）
      const postOwnerId = Number(post.user);
      if (postOwnerId !== session.uid && r.quotedUserId !== postOwnerId) {
        await sendMessage(session.uid, postOwnerId, `我评论了你的文章${titleLink}`);
      }
    }
    after(() => runContentReview("bbs_reply", replyId, content));
    return NextResponse.json({ id: replyId });
  }

  if (action === "edit") {
    const title = body.title !== undefined ? String(body.title).trim().slice(0, BBS_TITLE_LIMIT) : undefined;
    const content = body.content !== undefined ? String(body.content).trim().slice(0, BBS_CONTENT_LIMIT) : undefined;
    const board = body.board !== undefined ? parseInt(String(body.board), 10) : undefined;
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    if (title !== undefined && !title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (content !== undefined && !content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    // 编辑同样过滤（否则可用「先发正常内容、再改回敏感内容」绕过发布拦截）
    const hit = checkSensitiveAll([title, content]);
    if (!hit.ok) return reject(hit, "bbs.edit");
    // 移动板块是管理员特权
    const data: { title?: string; content?: string; board?: number } = { title, content };
    if (board !== undefined && admin && board in BBS_BOARD_NAMES) data.board = board;
    const ok = await updatePost(id, session.uid, admin, data);
    if (!ok) return NextResponse.json({ error: "无权编辑" }, { status: 403 });
    // 编辑同样送 AI 复审（取库内最终标题+正文，防止「先发正常内容、AI 放行后再改回敏感」）
    const cur = await prisma.bbsPost.findUnique({
      where: { id: BigInt(id) },
      select: { title: true, content: true },
    });
    if (cur) after(() => runContentReview("bbs_post", id, `${cur.title}\n${cur.content}`));
    return NextResponse.json({ ok: true });
  }

  if (action === "delete") {
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const ok = await deletePost(id, session.uid, admin);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "无权删除" }, { status: 403 });
  }

  if (action === "delete_reply") {
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const ok = await deleteReply(id, session.uid, admin);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "无权删除" }, { status: 403 });
  }

  if (action === "admin") {
    if (!admin) return NextResponse.json({ error: "无权操作" }, { status: 403 });
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const data: { isPinned?: boolean; isNice?: boolean; isLocked?: boolean; board?: number } = {};
    if (body.isPinned !== undefined) data.isPinned = !!body.isPinned;
    // 2026-10-23（张老师）：取消论坛高亮设定——isTop 不再接受写入（历史值仅留库备查）
    if (body.isNice !== undefined) data.isNice = !!body.isNice;
    if (body.isLocked !== undefined) data.isLocked = !!body.isLocked;
    if (body.board !== undefined) {
      const board = parseInt(String(body.board), 10);
      if (!(board in BBS_BOARD_NAMES)) return NextResponse.json({ error: "板块不存在" }, { status: 400 });
      data.board = board;
    }
    await adminSetPost(id, data);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
