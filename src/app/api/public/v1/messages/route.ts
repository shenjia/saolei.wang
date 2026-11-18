// 公开 API · 用户侧短消息列表（2026-11-19）
// GET /api/public/v1/messages?page=1&type=all[&size=30]
// 鉴权：X-Api-Key（scope=user）+ Bearer token；只查 token 本人收件箱。
// 口径与站内 /api/message?action=more 同源（lib/message.ts getMessageList）：
//   · type：all（默认）/ system（系统）/ private（私信）/ sent（已发送视角）
//   · 分页：页码语义，服务端页锚 15 条（MESSAGE_PAGESIZE）；size = 本批行数，
//     取 15 的整数倍、100 封顶（全站「加载更多」铁律 82ff927 同款）
//   · 行：id / content / isRead / isSystem / createTime（Unix 秒）/ from / to / sent
//     from·to 为发件人/收件人简卡 { id, chineseName, englishName, title }（sent 视角才有 to）
// 只读接口，不受维护模式影响（与站内一致：维护只挡发信）。

import { NextResponse } from "next/server";
import { userApiAuth } from "../_user";
import { getMessageList, MESSAGE_PAGESIZE, type MessageUserBrief } from "@/lib/message";

type MsgType = "all" | "system" | "private" | "sent";

/** 发件人/收件人简卡：只出 id + 姓名 + 军衔（不出头像与隐私字段） */
function briefOut(b: MessageUserBrief | null | undefined) {
  if (!b) return null;
  return { id: b.id, chineseName: b.chineseName, englishName: b.englishName, title: b.title };
}

export async function GET(req: Request) {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;

  const p = new URL(req.url).searchParams;
  const typeRaw = p.get("type");
  const type: MsgType =
    typeRaw === "system" || typeRaw === "private" || typeRaw === "sent" ? typeRaw : "all";
  const page = Math.max(1, parseInt(p.get("page") ?? "1", 10) || 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10) || MESSAGE_PAGESIZE;
  const size = Math.min(Math.ceil(sizeRaw / MESSAGE_PAGESIZE) * MESSAGE_PAGESIZE, 100);

  const { messages, total, pageSize } = await getMessageList(auth.ident.uid, page, type, size);
  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      content: m.content,
      isRead: m.isRead,
      isSystem: m.isSystem,
      createTime: m.createTime,
      from: briefOut(m.from),
      to: briefOut(m.to),
      sent: !!m.sent,
    })),
    hasMore: (page - 1) * pageSize + messages.length < total,
    total,
    pageSize,
    type,
    page,
  });
}
