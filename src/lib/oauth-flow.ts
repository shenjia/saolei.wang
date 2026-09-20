// 微信/QQ 扫码回调的共用分支逻辑：
// 1. 已登录状态下扫码 → 把该第三方身份绑定到当前账号（老用户强制绑定走这里）
// 2. 未登录 + 该身份已绑定 → 直接登录
// 3. 未登录 + 未绑定 → 发临时票据，进入「认领老账号 / 注册新账号」流程

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, setSession, setOauthTicket } from "@/lib/auth";
import { checkState, exchangeCode, siteUrl } from "@/lib/oauth";

function redirect(path: string): NextResponse {
  return NextResponse.redirect(`${siteUrl()}${path}`, 302);
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
      return redirect("/account/bind?error=taken"); // 该身份已被其他账号绑定
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
