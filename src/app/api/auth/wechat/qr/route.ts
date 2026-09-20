// 微信扫码入口：已配置密钥 → 302 到微信官方二维码页（内嵌 iframe 使用）
// 未配置（本地开发）→ 返回 mock 二维码页，点击模拟扫码

import { NextResponse } from "next/server";
import { issueState, wechatConfigured, wechatQrUrl, siteUrl } from "@/lib/oauth";

export async function GET(req: Request) {
  const state = await issueState();
  if (wechatConfigured()) {
    return NextResponse.redirect(wechatQrUrl(state), 302);
  }
  const mockid = new URL(req.url).searchParams.get("mockid");
  const code = mockid ? `mock_wechat_${mockid.replace(/\D/g, "")}` : "mock_wechat";
  const mockUrl = `${siteUrl()}/api/auth/wechat/callback?code=${code}&state=${state}`;
  return new NextResponse(mockPage("微信", mockUrl, "#07c160"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function mockPage(name: string, url: string, color: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f9f9f4}
.qr{width:180px;height:180px;border:8px solid ${color};border-radius:8px;display:flex;align-items:center;justify-content:center;background:#fff;color:#636359;font-size:14px;text-align:center;padding:10px;box-sizing:border-box}
a{margin-top:18px;padding:10px 28px;background:${color};color:#fff;border-radius:6px;text-decoration:none;font-size:15px}
p{color:#a8a89c;font-size:12px;margin-top:14px}
</style></head><body>
<div class="qr">开发模式<br>模拟${name}二维码</div>
<a href="${url}">模拟${name}用户扫码</a>
<p>配置密钥后此处显示真实二维码</p>
</body></html>`;
}
