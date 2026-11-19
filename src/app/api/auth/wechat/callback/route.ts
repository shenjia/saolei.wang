// 微信扫码回调：code → openid/unionid → 登录 / 绑定 / 注册分支

import { handleOauthCallback } from "@/lib/oauth-flow";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return handleOauthCallback("wechat", url.searchParams.get("code"), url.searchParams.get("state"));
}
