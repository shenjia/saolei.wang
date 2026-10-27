// 扫码后认领老账号：验证用户名密码 + 临时票据 → 绑定第三方身份并登录

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword, setSession, getOauthTicket, clearOauthTicket } from "@/lib/auth";
import { importQqAvatar, hasOwnAvatarPhoto } from "@/lib/oauth-avatar";
import { getClientIp } from "@/lib/net";

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

  // 首次绑定 QQ：处理授权头像（2026-10-26 / 10-27 张老师口径）
  // 老账号本人已传过照片 → 不自动替换，回一个标记，前端跳账户页弹「要不要换成
  // QQ 头像」浮窗；本人没照片 → 直接拉取送审（失败不影响绑定）
  let askQqAvatar = false;
  if (ticket.provider === "qq" && ticket.avatar) {
    const me = await prisma.user.findUnique({
      where: { id: auth.id },
      select: { avatar: true },
    });
    if (hasOwnAvatarPhoto(me?.avatar ?? "")) {
      askQqAvatar = true;
    } else {
      void importQqAvatar(Number(auth.id), ticket.avatar);
    }
  }

  await setSession({ uid: Number(auth.id), username: auth.username, role: auth.role }, getClientIp(req));
  await clearOauthTicket();
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: now },
  });
  return NextResponse.json({ ok: true, askQqAvatar });
}
