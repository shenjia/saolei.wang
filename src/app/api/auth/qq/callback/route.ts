// QQ 授权回调：code → openid → 登录 / 绑定 / 注册分支（分支逻辑在 oauth-flow.ts）
// 弹窗模式（企鹅图标 window.open 进来的）：不 302，输出「关窗 + 主窗跳转」页，
// 最终去向（含错误分支）由主窗口承接，弹窗自闭。

import { NextResponse } from "next/server";
import { handleOauthCallback } from "@/lib/oauth-flow";
import { consumePopup, popupClosePage } from "@/lib/oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const { popup, next } = await consumePopup();
  const res = await handleOauthCallback("qq", url.searchParams.get("code"), url.searchParams.get("state"));
  if (!popup) return res;
  // 分支结果统一是 302；取出目标地址交给关窗页（兜底走登录页报错）
  let target = res.headers.get("location") ?? "/account/login?error=broken";
  // 带来源页时（如账户管理页发起的绑定）：成功类去向（首页/bound）改回来源页，
  // 错误与认领/注册等中间流程仍走原目标。
  // **query 必须整体带过去**（2026-10-27）：绑定成功可能是 "/?bound=1&qqavatar=1"，
  // 后者驱动账户页弹「要不要换成 QQ 头像」浮窗，丢了参数就不问了
  if (next && (target === "/" || target.startsWith("/?"))) {
    target = `${next}${target.slice(1)}`; // "/" → next；"/?a=1&b=2" → "next?a=1&b=2"
  }
  return new NextResponse(popupClosePage(target), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
