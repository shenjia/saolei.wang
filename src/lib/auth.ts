// 账号体系基础库
// - 密码校验：兼容 2013 旧站 md5(password + salt)
// - 会话：httpOnly cookie + HMAC-SHA256 签名 JWT（零依赖，Node crypto 实现）
// - OAuth 临时票据：扫码回调后未绑定账号时，携带 openid 信息进入绑定/注册流程

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

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

export async function setSession(user: SessionUser): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sign(user, SESSION_TTL), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? verify<SessionUser>(token) : null;
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
