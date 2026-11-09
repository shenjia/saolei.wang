// 公开 API · 用户登录换 token（2026-11-09）
// POST /api/public/v1/login
// 请求体 JSON：{ "username": "...", "password": "..." }
// 校验通过 → 签发 7 天用户 token（落库 sha256），客户端保存后随请求带
// `Authorization: Bearer <token>`，作为该用户的登录态调用后续用户侧 API。
//
// 校验链与站内登录（/api/auth/login）完全同口径：
// verifyPassword(md5+salt，兼容旧站 11,564 账号) → oldUsername 引导 → 封禁检查
// （限时封禁到期当场解禁放行）→ 签发 token。
// 与 cookie 会话互不影响；登录统计（loginTimes/loginTime）一并累计。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { unbanUser } from "@/lib/ban";
import { formatDate } from "@/lib/format";
import { getClientIp } from "@/lib/net";
import { issueUserToken, userTokenRateLimit, USER_TOKEN_TTL } from "@/lib/usertoken";

export async function POST(req: Request) {
  // 防爆破：同 IP 每分钟最多 10 次
  const ip = getClientIp(req);
  if (!userTokenRateLimit(ip)) {
    return NextResponse.json(
      { error: "rate_limited", message: "尝试过于频繁，请稍后再试" },
      { status: 429 }
    );
  }

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
    // oldUsername 兜底（2026-11-09 张老师定：不放行——旧站被爆过库、旧凭据不可信）：
    // 命中旧登录名时返回黄色提示口径的错误，引导改用绑定邮箱登录；邮箱脱敏显示
    if (!auth) {
      const old = await prisma.userAuth.findFirst({
        where: { oldUsername: username },
        select: { username: true },
      });
      if (old) {
        const at = old.username.indexOf("@");
        const masked = at > 0 ? `${old.username[0]}*****${old.username.slice(at)}` : "绑定邮箱";
        return NextResponse.json(
          {
            error: `您已绑定 ${masked} 邮箱，请使用邮箱作为用户名登录`,
            hint: "oldUsername",
          },
          { status: 401 }
        );
      }
    }
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  // 封禁检查（与站内登录同口径）：status≠0 时看 ban_until——到期当场解禁放行，未到期拒绝
  const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { status: true, banUntil: true } });
  if (user && user.status !== 0) {
    const until = Number(user.banUntil);
    if (until > 0 && until <= Math.floor(Date.now() / 1000)) {
      await unbanUser(auth.id);
    } else {
      const hint = until > 0 ? `（至 ${formatDate(until, "Y-m-d H:i")}）` : "";
      return NextResponse.json({ error: `该账号已被封禁${hint}，如有疑问请联系站长` }, { status: 403 });
    }
  }

  const uid = Number(auth.id);
  const token = await issueUserToken(uid);

  // 登录统计（沿用旧站 user_stat 语义；不刷新 last_login_time/ip——与「最近活跃」
  // 和防小号 IP 关联口径解耦，API 登录不视为站内活跃）
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: BigInt(Math.floor(Date.now() / 1000)) },
  });

  return NextResponse.json({
    token,
    tokenType: "Bearer",
    expiresIn: USER_TOKEN_TTL,
    user: { id: uid, username: auth.username },
  });
}
