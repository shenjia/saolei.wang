// BBS API：发帖/编辑/删除/回帖/删回复/管理操作
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { prisma } from "@/lib/db";
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

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const admin = isManager(session.role);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const id = parseInt(String(body.id ?? ""), 10) || 0;

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
    const postId = await createPost(session.uid, board, title, content);
    return NextResponse.json({ id: postId });
  }

  if (action === "reply") {
    const content = String(body.content ?? "").trim().slice(0, BBS_CONTENT_LIMIT);
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    if (!admin && !(await canPost(session.uid))) {
      return NextResponse.json({ error: "加入排行后才能回复" }, { status: 403 });
    }
    const replyId = await createReply(id, session.uid, content, admin);
    if (replyId === "locked") return NextResponse.json({ error: "主题已锁定" }, { status: 403 });
    if (replyId === null) return NextResponse.json({ error: "主题不存在" }, { status: 404 });
    return NextResponse.json({ id: replyId });
  }

  if (action === "edit") {
    const title = body.title !== undefined ? String(body.title).trim().slice(0, BBS_TITLE_LIMIT) : undefined;
    const content = body.content !== undefined ? String(body.content).trim().slice(0, BBS_CONTENT_LIMIT) : undefined;
    const board = body.board !== undefined ? parseInt(String(body.board), 10) : undefined;
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    if (title !== undefined && !title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (content !== undefined && !content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    // 移动板块是管理员特权
    const data: { title?: string; content?: string; board?: number } = { title, content };
    if (board !== undefined && admin && board in BBS_BOARD_NAMES) data.board = board;
    const ok = await updatePost(id, session.uid, admin, data);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "无权编辑" }, { status: 403 });
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
    const data: { isPinned?: boolean; isTop?: boolean; isNice?: boolean; isLocked?: boolean; board?: number } = {};
    if (body.isPinned !== undefined) data.isPinned = !!body.isPinned;
    if (body.isTop !== undefined) data.isTop = !!body.isTop;
    if (body.isNice !== undefined) data.isNice = !!body.isNice;
    if (body.isLocked !== undefined) data.isLocked = !!body.isLocked;
    if (body.board !== undefined) {
      const board = parseInt(String(body.board), 10);
      if (!(board in BBS_BOARD_NAMES)) return NextResponse.json({ error: "板块不存在" }, { status: 400 });
      data.board = board;
    }
    // 公告板块一律强制高亮（展示层判定）——isTop 写操作对公告无效，防绕过前端直调
    if (data.isTop === false) {
      const post = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { board: true } });
      if (post?.board === 0) {
        return NextResponse.json({ error: "公告板块主题始终高亮，无需手动设置" }, { status: 400 });
      }
    }
    await adminSetPost(id, data);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
