// 注册接口：验证码 → 字段校验 → 邮箱唯一性 → 同 IP 限额 → 事务建号 → 自动登录
// 已登录用户重复注册直接拒绝；用户名即邮箱（与登录/找回密码同口径）
// 防小号（2026-10-19）：图形验证码 + 同 IP 限速/限额 + 注册 IP 落库

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, setSession } from "@/lib/auth";
import { validateRegister, createRegisteredUser, type RegisterInput } from "@/lib/register";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { getClientIp } from "@/lib/net";
import { rateLimit } from "@/lib/ratelimit";
import { verifyCaptcha } from "@/lib/captcha";

export async function POST(req: Request) {
  const session = await getSession();
  if (session) {
    return NextResponse.json({ error: "您已登录，无需重复注册" }, { status: 400 });
  }

  const ip = getClientIp(req);
  // 同 IP 注册尝试限速：每分钟最多 5 次（含验证码填错重试）
  if (ip && !rateLimit(`register:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
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

  // 图形验证码：强制校验（一次性，校验后立即作废）
  const captchaId = String(body.captchaId ?? "");
  const captchaText = String(body.captchaText ?? "");
  if (!captchaId || !captchaText || !verifyCaptcha(captchaId, captchaText)) {
    return NextResponse.json({ error: "验证码不正确", captcha: true }, { status: 400 });
  }

  const errors = validateRegister(input);
  // 中文名、拼音都公开展示；格式通过后再拦敏感词，避免盖掉格式错误
  for (const field of ["chineseName", "englishName"] as const) {
    if (errors[field]) continue;
    const hit = checkSensitive(input[field]);
    if (!hit.ok) {
      logSensitiveHit("register." + field, 0, hit);
      errors[field] = sensitiveRejectMessage(hit, "注册");
    }
  }
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  // 同 IP 当日注册限额：3 个/天（含扫码注册共用口径）
  if (ip) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayCount = await prisma.user.count({
      where: { registerIp: ip, createTime: { gte: BigInt(Math.floor(dayStart.getTime() / 1000)) } },
    });
    if (todayCount >= 3) {
      return NextResponse.json(
        { error: "该网络地址今日注册数量已达上限，如有疑问请联系站长" },
        { status: 429 },
      );
    }
  }

  const exists = await prisma.userAuth.findUnique({ where: { username: input.email } });
  if (exists) {
    return NextResponse.json({ errors: { email: "该邮箱已经被注册！" } }, { status: 409 });
  }

  let uid: number;
  try {
    uid = await createRegisteredUser(input, ip);
  } catch {
    // 并发下同邮箱撞唯一索引等兜底
    return NextResponse.json({ error: "注册失败，请稍候再试！" }, { status: 500 });
  }

  await setSession({ uid, username: input.email, role: 0 }, ip);
  return NextResponse.json({
    ok: true,
    chineseName: input.chineseName,
    englishName: input.englishName,
  });
}
