// /connect 授权页 · 确认授权接口（2026-11-12 元扫雷上传）
// POST /api/connect/authorize  body: { "app": "meta" }
// 鉴权：站内 session cookie（用户在授权页点「允许」时已登录）。
// 通过 → 签发 90 天 Bearer token（user_token 表 sha256 落库，同公开 API login 口径），
// 返回 { token, expiresIn, deepLink }——deepLink 供页面自动回跳 APP（scheme 注册制，
// 见 lib/connect-apps.ts）；未登记 scheme 的 app 返回空串（纯复制模式）。
//
// 防护：
// · JSON body 的 fetch POST 非跨站 simple request，天然挡 CSRF form 打点；
// · 同一用户每分钟最多签发 3 个 token（connectRateLimit，防脚本灌表）；
// · 封禁用户拒绝（与 requireUserToken 口径一致）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { issueUserToken, connectRateLimit } from "@/lib/usertoken";
import { findConnectApp } from "@/lib/connect-apps";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录后再授权" }, { status: 401 });
  }

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

  // 封禁拦截（与 requireUserToken 同口径：status=-1 拒绝）
  const me = await prisma.user.findUnique({
    where: { id: BigInt(session.uid) },
    select: { status: true },
  });
  if (me?.status === -1) {
    return NextResponse.json({ error: "账号已被封禁，无法授权" }, { status: 403 });
  }

  if (!connectRateLimit(session.uid)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const token = await issueUserToken(session.uid, app.tokenTtl);

  return NextResponse.json({
    token,
    tokenType: "Bearer",
    expiresIn: app.tokenTtl,
    // deep link 回跳（scheme 注册制；无 scheme 的 app 为空串）
    deepLink: app.scheme ? `${app.scheme}://auth?token=${encodeURIComponent(token)}` : "",
    app: { key: app.key, name: app.name },
    user: { id: session.uid, username: session.username },
  });
}
