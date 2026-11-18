// 公开 API · 设备授权流轮询（2026-11-12 元扫雷 device flow）
// GET /api/public/v1/connect/poll?code=cs-…
// 鉴权：X-Api-Key（须与发起 start 的同源 key，api_key.name 匹配）。
// 状态机（见 lib/connect-session.ts）：
//   { status: "pending" }                  用户尚未确认（APP 继续按 interval 轮询）
//   { status: "authorized", token, … }     用户已确认——token 明文仅本次出现，
//                                           服务端已原子标记消费，重放将得 consumed
//   { status: "denied" }                   用户点了「拒绝」
//   400 { status: "invalid" }              code 不存在 / 非本 key 发起
//   400 { status: "expired" }              会话超时（10 分钟）
//   400 { status: "consumed" }             已被拉取过（一次性，防重放）
// authorized 响应附 uid/username/expires_in，APP 落地展示即可。

import { NextResponse } from "next/server";
import { requirePartnerEx, unauthorized, rateLimited, partnerRateLimit } from "@/lib/partner";
import { findConnectApp } from "@/lib/connect-apps";
import { pollConnectSession } from "@/lib/connect-session";

export async function GET(req: Request) {
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  if (!partnerRateLimit(partner, "connect")) return rateLimited(partner.ratePerMin);

  const code = new URL(req.url).searchParams.get("code") ?? "";
  // app 从 code 所属会话推导——这里固定取 meta（当前唯一接入 device flow 的 APP）。
  // 后续多 APP 接入时 start 落库的 app_key 已带，可按会话行取 ConnectApp。
  const app = findConnectApp("meta");
  if (!app) return NextResponse.json({ error: "服务端配置错误" }, { status: 500 });

  const result = await pollConnectSession(code, partner.name, app);
  const status = result.status;

  if (status === "authorized") {
    return NextResponse.json({
      status,
      token: result.token,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      uid: result.uid,
      username: result.username,
    });
  }
  if (status === "pending" || status === "denied") {
    return NextResponse.json({ status });
  }
  // invalid / expired / consumed：客户端协议错误类
  return NextResponse.json({ status }, { status: 400 });
}
