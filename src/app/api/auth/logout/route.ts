// 退出登录

import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";

/**
 * 退出后不该回去的页面：这些页面自身要求登录（各页面的 `if (!session) redirect("/account/login")`），
 * 退回去只会被守卫立刻弹到登录页——等于绕一圈又回到登录页，不如直接回首页。
 * 守卫分散在 ~10 个页面里没有统一入口可复用，故在此集中列一份前缀；新增需登录页面时记得补这里。
 */
const LOGIN_REQUIRED_PREFIXES = [
  "/account",
  "/message",
  "/video/upload",
  "/admin",
  "/bbs/post",
  "/bbs/edit",
];

/**
 * 退出后回哪里：优先显式 ?next=，其次 Referer 指向的页面（排除上述需登录页面），都拿不到则回首页。
 *
 * 安全：只取 Referer 的 pathname+search，**丢弃 host**——Referer 可被伪造成外站，
 * 直接照搬就是开放重定向。
 */
function logoutTarget(req: Request): string {
  const usable = (p: string | null | undefined): p is string =>
    !!p &&
    p.startsWith("/") &&
    !p.startsWith("//") && // 协议相对 URL（//evil.com）
    !p.startsWith("/\\") && // 部分浏览器把 /\ 视作 //
    !LOGIN_REQUIRED_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`) || p.startsWith(`${pre}?`));

  const explicit = new URL(req.url).searchParams.get("next");
  if (usable(explicit)) return explicit;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const u = new URL(referer);
      const p = u.pathname + u.search;
      if (usable(p)) return p;
    } catch {
      /* Referer 非法，忽略，回落首页 */
    }
  }

  return "/";
}

export async function GET(req: Request) {
  await clearSession();
  // 手写相对 Location：不可用 siteUrl() 拼绝对地址——SITE_URL 未配时它回退到
  // http://localhost:3000，会把浏览器甩到内网/错误 host（2026-09-24 张老师实测踩坑）。
  return new NextResponse(null, { status: 302, headers: { Location: logoutTarget(req) } });
}
