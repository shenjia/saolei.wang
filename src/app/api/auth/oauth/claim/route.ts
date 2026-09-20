// 扫码后认领老账号：验证用户名密码 + 临时票据 → 绑定第三方身份并登录

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword, setSession, getOauthTicket, clearOauthTicket } from "@/lib/auth";

export async function POST(req: Request) {
  const ticket = await getOauthTicket();
  if (!ticket) {
    return NextResponse.json({ error: "扫码凭证已过期，请重新扫码" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username || !password) {
    return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });
  }

  const auth = await prisma.userAuth.findUnique({ where: { username } });
  if (!auth || !verifyPassword(password, auth.salt, auth.password)) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  // 同一账号不允许重复绑定同一平台
  const dup = await prisma.userOauth.findFirst({
    where: { userId: auth.id, provider: ticket.provider },
  });
  if (dup) {
    return NextResponse.json(
      { error: `该账号已绑定过${ticket.provider === "wechat" ? "微信" : "QQ"}` },
      { status: 409 }
    );
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.userOauth.create({
    data: {
      userId: auth.id,
      provider: ticket.provider,
      openid: ticket.openid,
      unionid: ticket.unionid,
      nickname: ticket.nickname,
      avatar: ticket.avatar,
      createTime: now,
      updateTime: now,
    },
  });

  await setSession({ uid: Number(auth.id), username: auth.username, role: auth.role });
  await clearOauthTicket();
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: now },
  });
  return NextResponse.json({ ok: true });
}
