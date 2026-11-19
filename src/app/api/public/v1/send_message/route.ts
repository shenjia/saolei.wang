// 公开 API · 用户侧发送短消息（2026-11-19）
// POST /api/public/v1/send_message  body: { to, content }
// 鉴权：X-Api-Key（scope=user）+ Bearer token；发件人从 token 推导。
// 业务闸门与站内 /api/message send 完全同源（逐条继承，管理员豁免按 role 判）：
//   · 收件人存在 / 不能给自己发 / 内容非空（≤200 字）；
//   · 敏感词前置闸（checkSensitive）；
//   · 黑名单闸（名单内用户不能给我发）；
//   · 未上榜限制（只能发管理员或回复对方先发来的消息）；
//   · 反群发频控（当日总量 + 同收件人频率 + 同文重复，429）。
// 成功返回 { ok: true, id: 消息id }；维护模式挡发信（503，与站内同款）。

import { NextResponse } from "next/server";
import { userApiAuth, readJson, parseIntParam, maintenanceGate } from "../_user";
import { sendMessage, checkDmRateLimit, MESSAGE_CONTENT_LIMIT } from "@/lib/message";
import { ugcRestricted, checkDmAudience } from "@/lib/ugc-limit";
import { blocklistReject } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";

export async function POST(req: Request) {
  const auth = await userApiAuth(req);
  if ("err" in auth) return auth.err;
  const gate = await maintenanceGate();
  if (gate) return gate;
  const { uid, role } = auth.ident;

  const body = await readJson(req);
  const to = parseIntParam(body.to);
  const content = String(body.content ?? "").trim().slice(0, MESSAGE_CONTENT_LIMIT);
  if (!to) return NextResponse.json({ error: "收件人不能为空" }, { status: 400 });
  if (to === uid) return NextResponse.json({ error: "不能给自己发信" }, { status: 400 });
  if (!content) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });

  const hit = checkSensitive(content);
  if (!hit.ok) {
    logSensitiveHit("api.send_message", uid, hit);
    return NextResponse.json({ error: sensitiveRejectMessage(hit, "发送") }, { status: 400 });
  }
  const target = await prisma.userAuth.findUnique({ where: { id: BigInt(to) }, select: { id: true } });
  if (!target) return NextResponse.json({ error: "收件人不存在" }, { status: 404 });
  // 黑名单闸（管理员豁免）
  if (role < 10) {
    const blk = await blocklistReject(to, uid);
    if (blk) return NextResponse.json({ error: blk }, { status: 403 });
  }
  // 未上榜限制（管理员豁免）
  if (role < 10 && (await ugcRestricted(uid, role))) {
    const audienceErr = await checkDmAudience(uid, to);
    if (audienceErr) return NextResponse.json({ error: audienceErr }, { status: 403 });
  }
  // 反群发频控（管理员豁免）
  if (role < 10) {
    const blocked = await checkDmRateLimit(uid, to, content);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 429 });
  }
  const id = await sendMessage(uid, to, content);
  return NextResponse.json({ ok: true, id });
}
