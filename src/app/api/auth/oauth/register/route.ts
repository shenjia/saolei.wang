// 扫码后注册新账号：临时票据 + 用户名/中文名/英文名
// 旧站约束：user.id == user_auth.id（11,564 个账号全部满足），事务内显式同 id 建两表
// 扫码注册用户无密码：password 存随机不可登录 hash，今后可另设

import { randomBytes, createHash } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSession, getOauthTicket, clearOauthTicket } from "@/lib/auth";
import { NEWS_TYPE } from "@/lib/config";
import { publishNews } from "@/lib/news";

const USERNAME_RE = /^[A-Za-z0-9_]{2,32}$/;

export async function POST(req: Request) {
  const ticket = await getOauthTicket();
  if (!ticket) {
    return NextResponse.json({ error: "扫码凭证已过期，请重新扫码" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const chineseName = String(body.chineseName ?? "").trim();
  const englishName = String(body.englishName ?? "").trim();

  if (!USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "用户名需为 2-32 位字母、数字或下划线" }, { status: 400 });
  }
  if (!chineseName || chineseName.length > 4) {
    return NextResponse.json({ error: "请填写中文名（4 字以内）" }, { status: 400 });
  }
  if (!englishName || englishName.length > 32) {
    return NextResponse.json({ error: "请填写英文名（32 字符以内）" }, { status: 400 });
  }

  const exists = await prisma.userAuth.findUnique({ where: { username } });
  if (exists) {
    return NextResponse.json({ error: "该用户名已被占用" }, { status: 409 });
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const salt = createHash("md5").update(randomBytes(16)).digest("hex");

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        chineseName,
        englishName,
        sex: 1,
        createTime: now,
        updateTime: now,
      },
    });
    await tx.userAuth.create({
      data: {
        id: u.id, // 旧站约束：user_auth.id == user.id
        username,
        password: createHash("md5").update(randomBytes(32)).digest("hex"), // 无密码占位，不可登录
        salt,
        role: 0,
        createTime: now,
        updateTime: now,
      },
    });
    await tx.userStat.create({
      data: { id: u.id, loginTimes: 1, loginTime: now, createTime: now, updateTime: now },
    });
    await tx.userOauth.create({
      data: {
        userId: u.id,
        provider: ticket.provider,
        openid: ticket.openid,
        unionid: ticket.unionid,
        nickname: ticket.nickname,
        avatar: ticket.avatar,
        createTime: now,
        updateTime: now,
      },
    });
    // 「加入扫雷网」动态（与邮箱注册同口径，仅个人主页可见）
    await publishNews({
      tx,
      type: NEWS_TYPE.JOIN,
      userId: Number(u.id),
      userScore: 0,
      createTime: Number(now),
    });
    return u;
  });

  await setSession({ uid: Number(user.id), username, role: 0 });
  await clearOauthTicket();
  return NextResponse.json({ ok: true });
}
