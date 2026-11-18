// 公开 API · 设备授权流发起（2026-11-12 元扫雷 device flow，张老师方案）
// POST /api/public/v1/connect/start
// 鉴权：X-Api-Key（合作方 key；任意有效 key 可发起——本接口只能「等用户主动
// 在雷网授权页点允许」，拿不到任何用户数据，故不设独立 scope，限速兜底）。
// body: { "app": "meta" }（connect-apps 注册制）
// 返回：{ code, authorize_url, expires_in, interval }——APP 打开 authorize_url
// （调起系统浏览器，用户已有登录态），随后按 interval 秒轮询
// GET /api/public/v1/connect/poll?code=…，用户确认后首次拉取即拿到 90 天
// Bearer token（见 lib/connect-session.ts 安全口径）。

import { NextResponse } from "next/server";
import {
  requirePartnerEx,
  unauthorized,
  rateLimited,
  partnerRateLimit,
} from "@/lib/partner";
import { findConnectApp } from "@/lib/connect-apps";
import { getClientIp } from "@/lib/net";
import {
  createConnectSession,
  CONNECT_SESSION_TTL,
  CONNECT_POLL_INTERVAL,
} from "@/lib/connect-session";

export async function POST(req: Request) {
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  if (!partnerRateLimit(partner, "connect")) return rateLimited(partner.ratePerMin);

  let body: { app?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const app = findConnectApp(body.app);
  if (!app) {
    return NextResponse.json({ error: "未知的授权目标应用" }, { status: 400 });
  }

  const { code } = await createConnectSession(app.key, partner.name, getClientIp(req));

  return NextResponse.json({
    code,
    authorize_url: `/connect?app=${encodeURIComponent(app.key)}&code=${encodeURIComponent(code)}`,
    expires_in: CONNECT_SESSION_TTL,
    interval: CONNECT_POLL_INTERVAL,
  });
}
