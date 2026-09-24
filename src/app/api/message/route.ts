// 站内信 API：发信 / 未读数 / 列表加载更多 / 全部已读 / 清空 / 管理员广播
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import {
  broadcast,
  clearMessages,
  getMessageList,
  getUnreadCount,
  markAllRead,
  sendMessage,
  MESSAGE_CONTENT_LIMIT,
} from "@/lib/message";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const action = req.nextUrl.searchParams.get("action");
  if (action === "unread") {
    return NextResponse.json({ unread: await getUnreadCount(session.uid) });
  }
  // 消息列表「加载更多」（页码语义，首屏 15 条，模式同 /api/bbs/more）
  if (action === "more") {
    const page = Math.max(2, parseInt(req.nextUrl.searchParams.get("page") ?? "2", 10) || 2);
    const { messages, total, pageSize } = await getMessageList(session.uid, page);
    return NextResponse.json({ messages, hasMore: page * pageSize < total, total });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "send") {
    const to = parseInt(String(body.to ?? ""), 10);
    const content = String(body.content ?? "").trim().slice(0, MESSAGE_CONTENT_LIMIT);
    if (!to) return NextResponse.json({ error: "收件人不能为空" }, { status: 400 });
    if (to === session.uid) return NextResponse.json({ error: "不能给自己发信" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    const target = await prisma.userAuth.findUnique({ where: { id: BigInt(to) }, select: { id: true } });
    if (!target) return NextResponse.json({ error: "收件人不存在" }, { status: 404 });
    const id = await sendMessage(session.uid, to, content);
    return NextResponse.json({ id });
  }

  if (action === "clear") {
    const count = await clearMessages(session.uid);
    return NextResponse.json({ count });
  }

  // 全部已读（2026-09-24 张老师要求）
  if (action === "readall") {
    const count = await markAllRead(session.uid);
    return NextResponse.json({ count });
  }

  if (action === "broadcast") {
    if (!isManager(session.role)) return NextResponse.json({ error: "无权广播" }, { status: 403 });
    const content = String(body.content ?? "").trim().slice(0, MESSAGE_CONTENT_LIMIT);
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    const count = await broadcast(session.uid, content);
    return NextResponse.json({ count });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
