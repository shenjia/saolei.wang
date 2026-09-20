// 账号密码登录（老用户）
// 校验 md5(password+salt)，兼容 2013 旧站全部 11,564 个账号
// 登录成功后检查微信/QQ 绑定：未绑定 → needBind=true，前端强制跳 /account/bind

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword, setSession } from "@/lib/auth";

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

  const uid = Number(auth.id);
  await setSession({ uid, username: auth.username, role: auth.role });

  // 更新登录统计（沿用旧站 user_stat 语义）
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: BigInt(Math.floor(Date.now() / 1000)) },
  });

  const bindCount = await prisma.userOauth.count({ where: { userId: auth.id } });
  return NextResponse.json({ ok: true, needBind: bindCount === 0 });
}
