// 账号密码登录（老用户）
// 校验 md5(password+salt)，兼容 2013 旧站全部 11,564 个账号
// 登录成功后检查微信/QQ 绑定：未绑定 → needBind=true，前端强制跳 /account/bind

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword, setSession } from "@/lib/auth";
import { OAUTH_ENABLED } from "@/lib/config";

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });
  }

  const auth = await prisma.userAuth.findUnique({ where: { username } });
  if (!auth || !verifyPassword(password, auth.salt, auth.password)) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  // 封禁检查（2026-09-24 管理后台：user.status 0=正常、-1=封禁）
  const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { status: true } });
  if (user && user.status !== 0) {
    return NextResponse.json({ error: "该账号已被封禁，如有疑问请联系站长" }, { status: 403 });
  }

  const uid = Number(auth.id);
  await setSession({ uid, username: auth.username, role: auth.role });

  // 更新登录统计（沿用旧站 user_stat 语义）
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: BigInt(Math.floor(Date.now() / 1000)) },
  });

  // 第三方登录未开放阶段不强制绑定（2026-09-24 张老师要求）
  if (!OAUTH_ENABLED) return NextResponse.json({ ok: true, needBind: false });

  const bindCount = await prisma.userOauth.count({ where: { userId: auth.id } });
  return NextResponse.json({ ok: true, needBind: bindCount === 0 });
}
