// BBS API：发帖/编辑/删除/回帖/删回复/编辑回复/管理操作
// 2026-11-07（张老师要求）：①回复可编辑——本人编辑自己的楼层，管理员编辑所有人的；
// ②管理员在前台对用户数据的一切操作（编辑主题/编辑回复/删主题/删回复/置顶精华锁定移动）
//   全量写 admin_log 留痕（本人自助操作不进管理日志，口径同 comment.selfDelete）
import { NextRequest, NextResponse, after } from "next/server";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { prisma } from "@/lib/db";
import { runContentReview } from "@/lib/content-review";
import { sendMessage } from "@/lib/message";
import { decodeLegacyEntities, ubbExcerpt } from "@/lib/format";
import { logAdmin } from "@/lib/admin/log";
import { clientIp } from "@/lib/stat";
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
  REPLY_QUOTE_LIMIT,
  ubb,
  updatePost,
  updateReply,
} from "@/lib/bbs";
import {
  checkSensitive,
  checkSensitiveAll,
  logSensitiveHit,
  sensitiveRejectMessage,
  type SensitiveResult,
} from "@/lib/sensitive";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";
import { checkUgcPostQuota, checkReplyOwnPost } from "@/lib/ugc-limit";

export async function POST(req: NextRequest) {
  // 维护模式：挡产生新内容/新楼层的入口（post/reply/edit/edit_reply）；delete/admin 是收敛操作，放行
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  if (["post", "reply", "edit", "edit_reply"].includes(action) && (await isMaintenanceOn())) {
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
    // 未上榜限额（2026-11-09 张老师要求）：原「加入排行后才能发布主题」放宽为 24h 1 主题，
    // 新手求助通道保留；上榜用户（canPost 通过）不受限
    if (!admin && !(await canPost(session.uid))) {
      const quotaErr = await checkUgcPostQuota(session.uid);
      if (quotaErr) return NextResponse.json({ error: quotaErr }, { status: 403 });
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
    // 未上榜限制（2026-11-09 张老师要求）：只能回复自己发布的主题（不限次数），上榜用户不受限
    if (!admin && !(await canPost(session.uid))) {
      const ownErr = await checkReplyOwnPost(session.uid, id);
      if (ownErr) return NextResponse.json({ error: ownErr }, { status: 403 });
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
    // 管理员前台编辑留痕（2026-11-07）：预取作者，本人编辑不进管理日志
    let editOwner: number | null = null;
    if (admin) {
      const row = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { user: true } });
      if (row) editOwner = Number(row.user);
    }
    const ok = await updatePost(id, session.uid, admin, data);
    if (!ok) return NextResponse.json({ error: "无权编辑" }, { status: 403 });
    if (editOwner !== null && editOwner !== session.uid) {
      await logAdmin({
        user: session.uid,
        action: "bbs.editPost",
        target: "bbs",
        targetId: id,
        detail: `管理员前台编辑主题 #${id}（作者 #${editOwner}）`,
        ip: clientIp(req.headers),
      });
    }
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
    // 管理员前台删主题留痕（2026-11-07）：预取作者/标题，本人删除不进管理日志
    let delOwner: number | null = null;
    let delTitle = "";
    if (admin) {
      const row = await prisma.bbsPost.findUnique({
        where: { id: BigInt(id) },
        select: { user: true, title: true },
      });
      if (row) {
        delOwner = Number(row.user);
        delTitle = decodeLegacyEntities(row.title).slice(0, 50);
      }
    }
    const ok = await deletePost(id, session.uid, admin);
    if (!ok) return NextResponse.json({ error: "无权删除" }, { status: 403 });
    if (admin && delOwner !== null && delOwner !== session.uid) {
      await logAdmin({
        user: session.uid,
        action: "bbs.deletePost",
        target: "bbs",
        targetId: id,
        detail: `管理员前台删除主题 #${id}《${delTitle}》（作者 #${delOwner}）`,
        ip: clientIp(req.headers),
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "delete_reply") {
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    // 管理员前台删回复留痕（2026-11-07）：预取作者与所在主题，本人/楼主删除不进管理日志
    let rOwner: number | null = null;
    let rPost = 0;
    let rPostOwner = 0;
    if (admin) {
      const row = await prisma.bbsReply.findUnique({
        where: { id: BigInt(id) },
        select: { user: true, post: true },
      });
      if (row) {
        rOwner = Number(row.user);
        rPost = Number(row.post);
        const post = await prisma.bbsPost.findUnique({ where: { id: row.post }, select: { user: true } });
        rPostOwner = post ? Number(post.user) : 0;
      }
    }
    const ok = await deleteReply(id, session.uid, admin);
    if (!ok) return NextResponse.json({ error: "无权删除" }, { status: 403 });
    if (admin && rOwner !== null && rOwner !== session.uid && rPostOwner !== session.uid) {
      await logAdmin({
        user: session.uid,
        action: "bbs.deleteReply",
        target: "bbs",
        targetId: id,
        detail: `管理员前台删除回复 #${id}（作者 #${rOwner}，主题 #${rPost}）`,
        ip: clientIp(req.headers),
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "edit_reply") {
    const content = String(body.content ?? "").trim().slice(0, BBS_CONTENT_LIMIT);
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    // 编辑同样过滤（防「先发正常内容、再改回敏感内容」绕过发布拦截）
    const hit = checkSensitive(content);
    if (!hit.ok) return reject(hit, "bbs.editReply");
    // 归属预取（留痕用：管理员编辑他人回复需进管理日志）
    const reply = await prisma.bbsReply.findUnique({
      where: { id: BigInt(id) },
      select: { user: true, post: true },
    });
    const ok = await updateReply(id, session.uid, admin, content);
    if (!ok) return NextResponse.json({ error: "无权编辑" }, { status: 403 });
    if (admin && reply && Number(reply.user) !== session.uid) {
      await logAdmin({
        user: session.uid,
        action: "bbs.editReply",
        target: "bbs",
        targetId: id,
        detail: `管理员前台编辑回复 #${id}（作者 #${Number(reply.user)}，主题 #${Number(reply.post)}）`,
        ip: clientIp(req.headers),
      });
    }
    // 编辑同样送 AI 复审（口径同主题编辑：防「先发正常内容、AI 放行后再改回敏感」）
    after(() => runContentReview("bbs_reply", id, content));
    // 返回服务端重渲染结果（与楼层流首屏同一 ubb/ubbExcerpt 管线），客户端就地替换
    return NextResponse.json({ ok: true, html: ubb(content), excerpt: ubbExcerpt(content, REPLY_QUOTE_LIMIT) });
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
    // 留痕（2026-11-07 张老师要求）：置顶/精华/锁定/移动全量进管理日志
    const flags = [
      data.isPinned !== undefined ? (data.isPinned ? "置顶" : "取消置顶") : "",
      data.isNice !== undefined ? (data.isNice ? "加精" : "取消精华") : "",
      data.isLocked !== undefined ? (data.isLocked ? "锁定" : "解锁") : "",
      data.board !== undefined ? `移动到「${BBS_BOARD_NAMES[data.board]}」板块` : "",
    ]
      .filter(Boolean)
      .join("、");
    await logAdmin({
      user: session.uid,
      action: "bbs.setPost",
      target: "bbs",
      targetId: id,
      detail: `管理员前台调整主题 #${id}：${flags}`,
      ip: clientIp(req.headers),
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

// 编辑预载（2026-11-07 回复编辑）：取楼层原始 UBB——本人或管理员；他人/未登录一律拒绝
export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  if (p.get("action") !== "reply_raw") {
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const id = parseInt(p.get("id") ?? "", 10) || 0;
  if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const row = await prisma.bbsReply.findUnique({
    where: { id: BigInt(id) },
    select: { user: true, status: true, content: true },
  });
  if (!row || row.status === -1) return NextResponse.json({ error: "回复不存在" }, { status: 404 });
  if (!isManager(session.role) && Number(row.user) !== session.uid) {
    return NextResponse.json({ error: "无权编辑" }, { status: 403 });
  }
  return NextResponse.json({ content: row.content });
}
