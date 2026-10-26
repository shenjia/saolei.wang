// 微信/QQ 扫码回调的共用分支逻辑：
// 1. 已登录状态下扫码 → 把该第三方身份绑定到当前账号（账户管理页手动绑定走这里）
// 2. 未登录 + 该身份已绑定 → 直接登录
// 3. 未登录 + 未绑定 → 发临时票据，进入「认领老账号 / 注册新账号」流程

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, setSession, setOauthTicket } from "@/lib/auth";
import { checkState, exchangeCode } from "@/lib/oauth";
import { importQqAvatar } from "@/lib/oauth-avatar";

function redirect(path: string): NextResponse {
  // 手写相对 Location（同 ranking/whereami 的约定）：siteUrl() 拼绝对地址在
  // SITE_URL 未配时会回退 http://localhost:3000，把浏览器甩到错误 host。
  // cookies() 的 set/delete 由 Next 自动并入返回的响应，不受此处构造方式影响。
  return new NextResponse(null, { status: 302, headers: { Location: path } });
}

export async function handleOauthCallback(
  provider: "wechat" | "qq",
  code: string | null,
  state: string | null
): Promise<NextResponse> {
  if (!(await checkState(state))) {
    return redirect("/account/login?error=state");
  }
  if (!code) {
    return redirect("/account/login?error=nocode");
  }

  let ticket;
  try {
    ticket = await exchangeCode(provider, code);
  } catch (e) {
    console.error(`[oauth] ${provider} code 交换失败:`, e);
    return redirect("/account/login?error=exchange");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const existing = await prisma.userOauth.findUnique({
    where: { provider_openid: { provider, openid: ticket.openid } },
  });
  const session = await getSession();

  // 1. 已登录 → 绑定到当前账号
  if (session) {
    if (existing) {
      if (Number(existing.userId) === session.uid) return redirect("/"); // 重复绑定，直接回首页
      return redirect("/account?error=taken"); // 该身份已被其他账号绑定（绑定入口在账户管理页）
    }
    await prisma.userOauth.create({
      data: {
        userId: BigInt(session.uid),
        provider,
        openid: ticket.openid,
        unionid: ticket.unionid,
        nickname: ticket.nickname,
        avatar: ticket.avatar,
        createTime: now,
        updateTime: now,
      },
    });
    // 首次绑定 QQ 成功：拉取授权头像送审（AI pass 生效 / 否则人工队列），失败不影响绑定（2026-10-26）
    if (provider === "qq" && ticket.avatar) {
      void importQqAvatar(session.uid, ticket.avatar);
    }
    return redirect("/?bound=1");
  }

  // 2. 未登录 + 已绑定 → 直接登录
  if (existing) {
    const auth = await prisma.userAuth.findUnique({ where: { id: existing.userId } });
    if (!auth) return redirect("/account/login?error=broken");
    await setSession({ uid: Number(auth.id), username: auth.username, role: auth.role });
    await prisma.userStat.updateMany({
      where: { id: auth.id },
      data: { loginTimes: { increment: 1 }, loginTime: now },
    });
    return redirect("/");
  }

  // 3. 未登录 + 未绑定 → 认领老账号或注册新账号
  await setOauthTicket(ticket);
  return redirect("/account/oauth");
}
