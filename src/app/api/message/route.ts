// 站内信 API：发信 / 未读数 / 列表加载更多 / 全部已读 / 清空
// 2026-10-27：前台广播入口下线（后台 /admin/messages 走 ops message.broadcast），
//   本路由的 broadcast 动作一并移除
import { NextRequest, NextResponse } from "next/server";
import { getSession, reissueSessionParentDomain } from "@/lib/auth";
import {
  clearMessages,
  getMessageList,
  getUnreadCount,
  markAllRead,
  markMessageRead,
  sendMessage,
  checkDmRateLimit,
  MESSAGE_CONTENT_LIMIT,
  MESSAGE_PAGESIZE,
} from "@/lib/message";
import { ugcRestricted, checkDmAudience } from "@/lib/ugc-limit";
import { prisma } from "@/lib/db";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const action = req.nextUrl.searchParams.get("action");
  if (action === "unread") {
    // 存量会话迁移补种（2026-10-28）：host-only cookie 补父域 Domain，rank-hk
    // 子域 WS 握手才能带上凭据；全站轮询接口，存量登录用户几秒内无感迁移
    await reissueSessionParentDomain();
    return NextResponse.json({ unread: await getUnreadCount(session.uid) });
  }
  // 消息列表「加载更多」（页码语义，首屏 15 条，模式同 /api/bbs/more）
  // 2026-10-14 加 type 类型筛选（all/system/private），与列表页 tabs 同口径；
  // 2026-10-27 加 sent=已发送视角（与列表页同口径；现网主列表已走 Pager 服务端分页）
  // 2026-11-04 加 size 递增批量（全站通用 PageSlider 加载更多，铁律 82ff927）：
  //   page 恒按 base(15) 页锚定，size 只是本批 take 行数——取整页倍数、100 封顶
  if (action === "more") {
    const typeRaw = req.nextUrl.searchParams.get("type");
    const type = typeRaw === "system" || typeRaw === "private" || typeRaw === "sent" ? typeRaw : "all";
    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
    const sizeRaw = parseInt(req.nextUrl.searchParams.get("size") ?? "", 10) || MESSAGE_PAGESIZE;
    const size = Math.min(Math.ceil(sizeRaw / MESSAGE_PAGESIZE) * MESSAGE_PAGESIZE, 100);
    const { messages, total, pageSize } = await getMessageList(session.uid, page, type, size);
    return NextResponse.json({ messages, hasMore: (page - 1) * pageSize + messages.length < total, total, pageSize });
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
    // 未上榜限制（2026-11-09 张老师要求）：只能发管理员或回复对方先发来的消息（管理员豁免）
    if (session.role < 10 && (await ugcRestricted(session.uid, session.role))) {
      const audienceErr = await checkDmAudience(session.uid, to);
      if (audienceErr) return NextResponse.json({ error: audienceErr }, { status: 403 });
    }
    // 反群发限制（2026-11-09 张老师要求）：仅手写私信；管理员豁免
    if (session.role < 10) {
      const blocked = await checkDmRateLimit(session.uid, to, content);
      if (blocked) {
        console.log(`[dm-ratelimit] uid=${session.uid} to=${to} blocked: ${blocked}`);
        return NextResponse.json({ error: blocked }, { status: 429 });
      }
    }
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
