// 绑定邮箱（2026-10-15）：老用户登录名非邮箱，忘记密码无法自助找回。
// 流程：提交邮箱 → 发验证链接（token 落 user_auth.email_token，24 小时有效）→
// 点击链接回站验证 → email_verified 置时间戳 + 登录名同步换成邮箱。重绑=再次提交覆盖草稿。

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { siteUrl } from "@/lib/oauth";
import { sendMail, smtpConfigured } from "@/lib/mailer";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL = 24 * 60 * 60; // 验证链接 24 小时有效（2026-10-15 张老师拍板：30 分钟太紧）

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "请填写邮箱" }, { status: 400 });
  if (email.length > 64 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }

  // 冲突检查：不能是别人的登录名；不能是别人已验证的绑定邮箱
  const [asUsername, asVerifiedEmail] = await Promise.all([
    prisma.userAuth.findUnique({ where: { username: email } }),
    prisma.userAuth.findFirst({ where: { email, emailVerified: { not: 0 } } }),
  ]);
  if (asUsername && asUsername.id !== BigInt(session.uid)) {
    // 2026-10-15 张老师拍板：点明占坑来源（新站注册 = 邮箱即登录名）
    return NextResponse.json(
      { error: "该邮箱已被注册为另一个账号的登录名，无法绑定；请换用其他邮箱" },
      { status: 400 },
    );
  }
  if (asVerifiedEmail && asVerifiedEmail.id !== BigInt(session.uid)) {
    return NextResponse.json({ error: "该邮箱已被其他账号绑定" }, { status: 400 });
  }

  if (!smtpConfigured()) {
    return NextResponse.json({ error: "邮件服务未配置，暂时无法发送验证邮件" }, { status: 503 });
  }

  const token = randomBytes(16).toString("hex");
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.userAuth.update({
    where: { id: BigInt(session.uid) },
    data: { email, emailToken: token, emailVerified: 0, updateTime: now },
  });

  const url = `${siteUrl()}/account/email/verify?token=${token}`;
  await sendMail(
    email,
    "扫雷网邮箱绑定验证",
    `您正在为扫雷网账号绑定邮箱：${email}\n\n请点击以下链接完成验证（24 小时内有效）：\n\n${url}\n\n如果这不是您的操作，请忽略本邮件。`,
  );

  return NextResponse.json({ ok: true });
}
