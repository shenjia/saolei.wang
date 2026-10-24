// 账号密码登录（老用户）
// 校验 md5(password+salt)，兼容 2013 旧站全部 11,564 个账号
// 2026-10-25 张老师定：登录后不再强制绑定微信/QQ（QQ 改账户管理页手动绑定）；
// 邮箱绑定提醒沿用旧站形式（账户管理页账户名后「绑定邮箱」入口，邮箱可找回密码）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword, setSession } from "@/lib/auth";
import { unbanUser } from "@/lib/ban";
import { formatDate } from "@/lib/format";
import { getClientIp } from "@/lib/net";

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
  // 2026-10-16 限时封禁：ban_until>0 且已到期 → 当场解禁放行（连坐录像一并恢复）；
  // 未到期提示解封时间；ban_until=0 为永久封禁
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
  await setSession({ uid, username: auth.username, role: auth.role }, getClientIp(req));

  // 更新登录统计（沿用旧站 user_stat 语义）
  await prisma.userStat.updateMany({
    where: { id: auth.id },
    data: { loginTimes: { increment: 1 }, loginTime: BigInt(Math.floor(Date.now() / 1000)) },
  });

  // 2026-10-25：不强制绑定第三方，直接成功
  return NextResponse.json({ ok: true });
}
