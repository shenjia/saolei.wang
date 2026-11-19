// 找回密码 API：申请重置链接 / 用令牌改密码
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { consumeResetToken, createResetToken, sendResetEmail } from "@/lib/password-reset";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "forgot") {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    const created = await createResetToken(email);
    // 无论邮箱是否存在都返回成功，避免账号枚举
    if (created) {
      const base = process.env.SITE_URL ?? req.nextUrl.origin;
      await sendResetEmail(email, `${base}/account/reset?token=${created.token}`).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "reset") {
    const token = String(body.token ?? "").trim();
    const password = String(body.password ?? "");
    if (!token) return NextResponse.json({ error: "链接无效" }, { status: 400 });
    if (password.length < 6) return NextResponse.json({ error: "密码至少 6 位" }, { status: 400 });
    const userId = await consumeResetToken(token);
    if (!userId) return NextResponse.json({ error: "链接已失效，请重新申请" }, { status: 400 });
    const salt = randomBytes(16).toString("hex");
    await prisma.userAuth.update({
      where: { id: BigInt(userId) },
      data: { password: hashPassword(password, salt), salt, updateTime: BigInt(Math.floor(Date.now() / 1000)) },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
