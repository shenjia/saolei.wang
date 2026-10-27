// 站内信 API：发信 / 未读数 / 列表加载更多 / 全部已读 / 清空
// 2026-10-27：前台广播入口下线（后台 /admin/messages 走 ops message.broadcast），
//   本路由的 broadcast 动作一并移除
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  clearMessages,
  getMessageList,
  getUnreadCount,
  markAllRead,
  markMessageRead,
  sendMessage,
  MESSAGE_CONTENT_LIMIT,
} from "@/lib/message";
import { prisma } from "@/lib/db";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const action = req.nextUrl.searchParams.get("action");
  if (action === "unread") {
    return NextResponse.json({ unread: await getUnreadCount(session.uid) });
  }
  // 消息列表「加载更多」（页码语义，首屏 15 条，模式同 /api/bbs/more）
  // 2026-10-14 加 type 类型筛选（all/system/private），与列表页 tabs 同口径；
  // 2026-10-27 加 sent=已发送视角（与列表页同口径；现网主列表已走 Pager 服务端分页）
  if (action === "more") {
    const page = Math.max(2, parseInt(req.nextUrl.searchParams.get("page") ?? "2", 10) || 2);
    const typeRaw = req.nextUrl.searchParams.get("type");
    const type = typeRaw === "system" || typeRaw === "private" || typeRaw === "sent" ? typeRaw : "all";
    const { messages, total, pageSize } = await getMessageList(session.uid, page, type);
    return NextResponse.json({ messages, hasMore: page * pageSize < total, total });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  // 维护模式：挡用户发信（send）；已读/清空/管理员广播不受影响
  const pre = await req.json().catch(() => ({}));
  if (String(pre.action ?? "") === "send" && (await isMaintenanceOn())) {
    return maintenanceReject() as unknown as NextResponse;
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = pre;
  const action = String(body.action ?? "");

  if (action === "send") {
    const to = parseInt(String(body.to ?? ""), 10);
    const content = String(body.content ?? "").trim().slice(0, MESSAGE_CONTENT_LIMIT);
    if (!to) return NextResponse.json({ error: "收件人不能为空" }, { status: 400 });
    if (to === session.uid) return NextResponse.json({ error: "不能给自己发信" }, { status: 400 });
    if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    const hit = checkSensitive(content);
    if (!hit.ok) {
      logSensitiveHit("message.send", session.uid, hit);
      return NextResponse.json({ error: sensitiveRejectMessage(hit, "发送") }, { status: 400 });
    }
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

  // 单条已读（2026-10-17 详情页下线，列表点击即读）
  if (action === "read") {
    const id = parseInt(String(body.id ?? ""), 10);
    if (!id) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const ok = await markMessageRead(id, session.uid);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "消息不存在" }, { status: 404 });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
