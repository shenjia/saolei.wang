// 注册接口：字段校验 → 邮箱唯一性 → 事务建号 → 自动登录
// 已登录用户重复注册直接拒绝；用户名即邮箱（与登录/找回密码同口径）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, setSession } from "@/lib/auth";
import { validateRegister, createRegisteredUser, type RegisterInput } from "@/lib/register";

export async function POST(req: Request) {
  const session = await getSession();
  if (session) {
    return NextResponse.json({ error: "您已登录，无需重复注册" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const input: RegisterInput = {
    email: String(body.email ?? "").trim(),
    password: String(body.password ?? ""),
    confirm: String(body.confirm ?? ""),
    chineseName: String(body.chineseName ?? "").trim(),
    englishName: String(body.englishName ?? "").trim(),
    sex: Number(body.sex),
    area: String(body.area ?? "").trim(),
  };

  const errors = validateRegister(input);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const exists = await prisma.userAuth.findUnique({ where: { username: input.email } });
  if (exists) {
    return NextResponse.json({ errors: { email: "该邮箱已经被注册！" } }, { status: 409 });
  }

  let uid: number;
  try {
    uid = await createRegisteredUser(input);
  } catch {
    // 并发下同邮箱撞唯一索引等兜底
    return NextResponse.json({ error: "注册失败，请稍候再试！" }, { status: 500 });
  }

  await setSession({ uid, username: input.email, role: 0 });
  return NextResponse.json({
    ok: true,
    chineseName: input.chineseName,
    englishName: input.englishName,
  });
}
