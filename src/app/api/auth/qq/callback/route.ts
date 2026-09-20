// QQ 授权回调：code → openid → 登录 / 绑定 / 注册分支

import { handleOauthCallback } from "@/lib/oauth-flow";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return handleOauthCallback("qq", url.searchParams.get("code"), url.searchParams.get("state"));
}
