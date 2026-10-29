// 账号体系基础库
// - 密码校验：兼容 2013 旧站 md5(password + salt)
// - 会话：httpOnly cookie + HMAC-SHA256 签名 JWT（零依赖，Node crypto 实现）
// - OAuth 临时票据：扫码回调后未绑定账号时，携带 openid 信息进入绑定/注册流程

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { ensureBansLifted } from "./ban";

const SESSION_COOKIE = "saolei_session";
const TICKET_COOKIE = "saolei_oauth_ticket";
const SESSION_TTL = 7 * 24 * 3600; // 7 天
const TICKET_TTL = 10 * 60; // 10 分钟，扫码后绑定/注册的窗口期

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("缺少环境变量 AUTH_SECRET");
  return s;
}

// ---------- 密码 ----------

export function hashPassword(password: string, salt: string): string {
  return createHash("md5").update(password + salt).digest("hex");
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  const a = Buffer.from(hashPassword(password, salt));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 极简 JWT（HS256） ----------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: object, ttlSec: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verify<T>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expect = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload as T;
  } catch {
    return null;
  }
}

// ---------- 会话 ----------

export interface SessionUser {
  uid: number; // user.id
  username: string;
  role: number;
}

export async function setSession(user: SessionUser, ip = ""): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sign(user, SESSION_TTL), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 父域 cookie（2026-10-28 多地域排行）：跨地域 WS 直连 rank-hk.saolei.wang
    // 等子域时浏览器才会携带凭据（host-only cookie 不随子域 WS 发送），
    // authority 握手的 session HMAC 校验才能通过。同一运营者子域，可接受
    domain: ".saolei.wang",
    maxAge: SESSION_TTL,
    secure: process.env.NODE_ENV === "production",
  });
  // 刷新最近登录时间 + 最近登录 IP（防小号关联，2026-10-19）；失败不阻断登录
  // （2026-10-30 起 last_login_time 兼作「最近活跃」，日常浏览/UGC 由 touchLastLogin 节流刷新，
  //  这里只在真正登录时写，保证 last_login_ip 与 last_login_time 同时落）
  try {
    await prisma.user.update({
      where: { id: BigInt(user.uid) },
      data: {
        lastLoginTime: BigInt(Math.floor(Date.now() / 1000)),
        ...(ip ? { lastLoginIp: ip } : {}),
      },
    });
  } catch {
    /* 忽略 */
  }
}

/** 存量会话迁移补种（2026-10-28 多地域排行）：会话 cookie 原为 host-only（无
 *  Domain 属性），浏览器不会把它发给 rank-hk.saolei.wang 等子域——authority WS
 *  握手 401 死循环（21:56 香港侧实测同一用户 3-6s 一次 401，前台反复弹「连接
 *  中断」）。登录已带父域 Domain，但存量会话要等重新登录才迁移。在最高频的
 *  unread 轮询里回显同值 token 并补上 Domain 属性，存量登录用户几秒内无感
 *  迁移。不重签不改值：host-only 与父域两枚同名 cookie 共存期值相同，解析
 *  无歧义；迁移完成后重设为同值无副作用 */
export async function reissueSessionParentDomain(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return;
  // 从 JWT payload 读 exp 定 maxAge，与原 token 生命周期精确一致（不滑期）
  let maxAge = 0;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload.exp === "number") maxAge = Math.floor(payload.exp - Date.now() / 1000);
  } catch {
    return;
  }
  if (maxAge <= 0) return;
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    domain: ".saolei.wang",
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
}

// ---------- 活跃度心跳（2026-10-30 张老师口径） ----------
// last_login_time 语义升级：不再只是「最近一次登录」，而是「最近活跃」——登录用户只要
// 在站里看过页面（getSession 每页必经）或产生 UGC（传录像 / 发评论 / 在线练习等，全部
// 要求登录态、必经 getSession），就刷新。进程内 Map 节流，每用户 5 分钟最多一条
// 主键 UPDATE；fire-and-forget 不 await，不给任何请求增加延迟。
// last_login_ip 仍只在真正登录（setSession）时刷新，防小号 IP 关联口径不变。
const TOUCH_INTERVAL = 5 * 60; // 秒
const lastTouch = new Map<number, number>(); // uid -> 本进程上次刷新 wall clock（ms）

export function touchLastLogin(uid: number): void {
  const now = Date.now();
  if (now - (lastTouch.get(uid) ?? 0) < TOUCH_INTERVAL * 1000) return;
  lastTouch.set(uid, now);
  prisma.user
    .update({
      where: { id: BigInt(uid) },
      data: { lastLoginTime: BigInt(Math.floor(now / 1000)) },
    })
    .catch(() => {
      /* 活跃刷新失败不阻断请求，下个节流窗口自然重试 */
    });
}

export async function getSession(): Promise<SessionUser | null> {
  // 到期限时封禁的节流清扫兜底（60s 一次，2026-10-16）；读会话每页必经，顺便带动全站自动解禁
  await ensureBansLifted();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = verify<SessionUser>(token);
  if (user) touchLastLogin(user.uid);
  return user;
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

// ---------- OAuth 临时票据 ----------

export interface OauthTicket {
  provider: "wechat" | "qq";
  openid: string;
  unionid: string;
  nickname: string;
  avatar: string;
}

export async function setOauthTicket(t: OauthTicket): Promise<void> {
  const jar = await cookies();
  jar.set(TICKET_COOKIE, sign({ ...t }, TICKET_TTL), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: TICKET_TTL,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function getOauthTicket(): Promise<OauthTicket | null> {
  const jar = await cookies();
  const token = jar.get(TICKET_COOKIE)?.value;
  return token ? verify<OauthTicket>(token) : null;
}

export async function clearOauthTicket(): Promise<void> {
  const jar = await cookies();
  jar.delete(TICKET_COOKIE);
}
