// QQ 登录入口：已配置密钥 → 302 到 QQ 互联授权页（支持扫码 / 一键登录）
// 未配置（本地开发）→ 返回 mock 页，点击模拟授权

import { NextResponse } from "next/server";
import { issueState, qqConfigured, qqAuthorizeUrl, siteUrl } from "@/lib/oauth";
import { mockPage } from "@/app/api/auth/wechat/qr/route";

export async function GET(req: Request) {
  const state = await issueState();
  if (qqConfigured()) {
    return NextResponse.redirect(qqAuthorizeUrl(state), 302);
  }
  const mockid = new URL(req.url).searchParams.get("mockid");
  const code = mockid ? `mock_qq_${mockid.replace(/\D/g, "")}` : "mock_qq";
  const mockUrl = `${siteUrl()}/api/auth/qq/callback?code=${code}&state=${state}`;
  return new NextResponse(mockPage("QQ", mockUrl, "#12b7f5"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
