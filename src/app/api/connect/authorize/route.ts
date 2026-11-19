// /connect 授权页 · 确认授权接口（2026-11-12 元扫雷上传）
// POST /api/connect/authorize  body: { "app": "meta", "code"?: "cs-…", "deny"?: bool }
// 鉴权：站内 session cookie（用户在授权页点「允许/拒绝」时已登录）。
//
// 两种模式：
// · device flow（带 code，元扫雷插件主链路）：只做状态流转——status 0→1（允许）
//   或 0→2（拒绝）+ 写 uid，**不签发 token**；token 由 APP 轮询
//   /api/public/v1/connect/poll 首次拉取时才签发（库中只存 hash，明文仅
//   poll 响应出现一次，见 lib/connect-session.ts）。
// · 旧模式（无 code，复制粘贴 / deep link 兜底）：直接签发 90 天 Bearer token
//   返回 { token, expiresIn, deepLink }——页面展示令牌供手动收取。
//
// 防护：
// · JSON body 的 fetch POST 非跨站 simple request，天然挡 CSRF form 打点；
// · 同一用户每分钟最多签发 3 个 token（connectRateLimit，防脚本灌表）；
// · 封禁用户拒绝（与 requireUserToken 口径一致）；
// · device flow 会话校验：app_key 匹配、未过期、status=0（流转幂等）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { issueUserToken, connectRateLimit } from "@/lib/usertoken";
import { findConnectApp } from "@/lib/connect-apps";
import { approveConnectSession, findConnectSession } from "@/lib/connect-session";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录后再授权" }, { status: 401 });
  }

  let body: { app?: string; code?: string; deny?: boolean };
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

  // ── device flow：有 code 只做状态流转，不签发 token ──
  if (body.code) {
    const row = await findConnectSession(body.code);
    if (!row || row.appKey !== app.key) {
      return NextResponse.json({ error: "授权请求不存在或已过期，请回到 APP 重新发起授权" }, { status: 400 });
    }
    const ok = await approveConnectSession(body.code, session.uid, body.deny === true);
    if (!ok) {
      // 状态已流转（重复点按 / 已被消费）：幂等告知当前状态即可
      return NextResponse.json({ ok: false, error: "该授权请求已处理过，请回到 APP 查看" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, deviceFlow: true, denied: body.deny === true });
  }

  // ── 旧模式：无 code 直接签发（复制 / deep link 兜底）──
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
