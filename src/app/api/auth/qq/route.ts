// QQ 登录入口：已配置密钥 → 302 到 QQ 互联授权页（可扫码 / 一键登录）
// 未配置（本地开发）→ 返回 mock 页，点击模拟授权
// ?popup=1（企鹅图标弹窗）：种弹窗标记 + display=pc 小版式授权页，回调将输出关窗页

import { NextResponse } from "next/server";
import { issueState, markPopup, qqConfigured, qqAuthorizeUrl, siteUrl } from "@/lib/oauth";
import { mockPage } from "@/app/api/auth/wechat/qr/route";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const popup = url.searchParams.get("popup") === "1";
  // next = 授权成功后主窗口回跳地址（账户管理页的绑定入口传 /account）
  await markPopup(popup, url.searchParams.get("next") ?? "");
  const state = await issueState();
  if (qqConfigured()) {
    return NextResponse.redirect(qqAuthorizeUrl(state, popup ? "pc" : undefined), 302);
  }
  const mockid = url.searchParams.get("mockid");
  const code = mockid ? `mock_qq_${mockid.replace(/\D/g, "")}` : "mock_qq";
  const mockUrl = `${siteUrl()}/api/auth/qq/callback?code=${code}&state=${state}`;
  return new NextResponse(mockPage("QQ", mockUrl, "#12b7f5"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
