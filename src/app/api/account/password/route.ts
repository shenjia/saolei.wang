// 修改密码（移植 forms/PasswordForm：验原密码、新密码 6-20 位、两次一致；盐不变）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hashPassword, verifyPassword } from "@/lib/auth";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: { password?: string; newPassword?: string; newRepeat?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { password = "", newPassword = "", newRepeat = "" } = body;
  if (!password || !newPassword || !newRepeat) {
    return NextResponse.json({ error: "请填写完整" }, { status: 400 });
  }
  if (newPassword.length < 6 || newPassword.length > 20) {
    return NextResponse.json({ error: "新密码长度须为 6-20 位" }, { status: 400 });
  }
  if (newPassword !== newRepeat) {
    return NextResponse.json({ error: "两次输入的新密码不一致" }, { status: 400 });
  }

  const auth = await prisma.userAuth.findUnique({ where: { id: BigInt(session.uid) } });
  if (!auth || !verifyPassword(password, auth.salt, auth.password)) {
    return NextResponse.json({ error: "原密码错误" }, { status: 400 });
  }

  await prisma.userAuth.update({
    where: { id: auth.id },
    data: {
      password: hashPassword(newPassword, auth.salt),
      updateTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
  return NextResponse.json({ ok: true });
}
