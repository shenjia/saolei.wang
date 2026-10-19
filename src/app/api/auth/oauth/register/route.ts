// 扫码后注册新账号：临时票据 + 用户名/中文名/英文名
// 旧站约束：user.id == user_auth.id（11,564 个账号全部满足），事务内显式同 id 建两表
// 扫码注册用户无密码：password 存随机不可登录 hash，今后可另设

import { randomBytes, createHash } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSession, getOauthTicket, clearOauthTicket } from "@/lib/auth";
import { NEWS_TYPE } from "@/lib/config";
import { publishNews } from "@/lib/news";
import { checkSensitiveAll, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { checkReservedNames } from "@/lib/register";
import { getClientIp } from "@/lib/net";
import { rateLimit } from "@/lib/ratelimit";

const USERNAME_RE = /^[A-Za-z0-9_]{2,32}$/;
// 2026-10-19 防小号：用户名至少含 1 个字母（防纯数字 QQ 号式批量账号）
const USERNAME_HAS_LETTER = /[A-Za-z]/;
// 与邮箱注册同口径（主站 register.ts）：中文姓名 2~6 汉字；拼音每词首字母大写、词数=字数
const CHINESE_NAME_RE = /^[\u4e00-\u9fa5]{2,6}$/;
const ENGLISH_NAME_RE = /^([A-Z][a-z]{0,5} ?){2,6}$/;

export async function POST(req: Request) {
  const ticket = await getOauthTicket();
  if (!ticket) {
    return NextResponse.json({ error: "扫码凭证已过期，请重新扫码" }, { status: 400 });
  }

  const ip = getClientIp(req);
  if (ip && !rateLimit(`oauth-register:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const chineseName = String(body.chineseName ?? "").trim();
  const englishName = String(body.englishName ?? "").trim();

  if (!USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "用户名需为 2-32 位字母、数字或下划线" }, { status: 400 });
  }
  if (!USERNAME_HAS_LETTER.test(username)) {
    return NextResponse.json({ error: "用户名不能是纯数字，需至少含 1 个字母" }, { status: 400 });
  }
  if (!CHINESE_NAME_RE.test(chineseName)) {
    return NextResponse.json({ error: "请填写中文名（2~6 个汉字）" }, { status: 400 });
  }
  if (!ENGLISH_NAME_RE.test(englishName)) {
    return NextResponse.json({ error: "英文名格式不合法：每词首字母大写（如 Sanjia Zhang）" }, { status: 400 });
  }
  if (englishName.trim().split(/\s+/).length !== [...chineseName].length) {
    return NextResponse.json({ error: "拼音和姓名字数不同！" }, { status: 400 });
  }
  const reserved = checkReservedNames(chineseName, englishName);
  if (reserved) {
    return NextResponse.json({ error: reserved }, { status: 400 });
  }
  const nameHit = checkSensitiveAll([chineseName, englishName]);
  if (!nameHit.ok) {
    logSensitiveHit("oauth.register", 0, nameHit);
    return NextResponse.json({ error: sensitiveRejectMessage(nameHit, "注册") }, { status: 400 });
  }

  // 同 IP 当日注册限额：与邮箱注册共用 register_ip 口径（3 个/天）
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
        registerIp: ip,
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
      createTime: Number(now),
    });
    return u;
  });

  await setSession({ uid: Number(user.id), username, role: 0 }, ip);
  await clearOauthTicket();
  return NextResponse.json({ ok: true });
}
