// /connect 授权页 · 会话状态查询（2026-11-12 device flow 页面闭环）
// GET /api/connect/poll_status?code=cs-…
// 鉴权：站内 session cookie。仅返回状态（不返回 token——token 只走公开 API poll）。
// 授权页组件在用户点「允许」后每 3 秒轮询本接口：status 变 3（APP 已拉取）
// 时页面显示「元扫雷已接收令牌，绑定完成」。
// code 高熵（288bit）+ 登录态双闸，无需额外限速（超频充其量自查状态）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findConnectSession } from "@/lib/connect-session";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const code = new URL(req.url).searchParams.get("code") ?? "";
  const row = await findConnectSession(code);
  if (!row) return NextResponse.json({ status: "expired" });

  return NextResponse.json({ status: row.status });
}
