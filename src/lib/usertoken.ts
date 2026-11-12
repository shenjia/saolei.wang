// 用户侧 API 登录令牌（2026-11-09）：公开 API 体系新增用户登录态。
// 流程：客户端 POST 用户名密码 → 校验通过签发 7 天 token（落库 sha256）→
// 客户端保存，后续用户侧 API 请求带 `Authorization: Bearer <token>` 验证身份。
//
// 设计口径：
// · token 明文 = ut-<48 位随机>（≈288bit 熵），只存 sha256 哈希（与 api_key 同款）——
//   明文仅在 login 响应中出现一次，库被拖走也无法冒用；
// · 校验走 sha256 后等值查表（哈希等长、unique 索引命中即通过，无需恒时比较）；
// · 7 天有效期，签发时刻固定，不滑动续期；过期/吊销（status=0）/用户封禁 → 401；
// · 进程内缓存 60s：命中缓存时跳过查库与封禁探测（封禁/吊销变更最迟 60s 生效）；
// · 重登签发新 token 不顶掉旧 token（多端并存），无清理任务——过期行查询天然跳过，
//   如后续需要可在后台补一个过期清扫。
//
// 限速：login 走 IP 维度滑动窗口（10 次/分钟），防在线爆破。

import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/partner";
import { rateLimit } from "@/lib/ratelimit";
import { ensureBansLifted } from "@/lib/ban";

export const USER_TOKEN_TTL = 7 * 24 * 3600; // 7 天（秒）
/** /connect 授权页签发的 token 有效期（2026-11-12 元扫雷 APP 授权口径）：
 *  APP 场景用户不会频繁重授权，给 90 天；后续如需吊销管理再加用户中心入口。 */
export const CONNECT_TOKEN_TTL = 90 * 24 * 3600; // 90 天（秒）
/** login 防爆破：同 IP 每分钟最多 10 次 */
const LOGIN_RATE_PER_MIN = 10;

interface TokenRow {
  uid: number;
  username: string;
  role: number;
}

/** 进程内缓存：hash → 身份快照，60s 过期（封禁/吊销变更最迟 60s 生效） */
const cache = new Map<string, { ident: TokenRow; at: number }>();
const CACHE_TTL = 60_000;

/** 生成新 token 明文：ut- + 48 位 URL 安全随机（≈288bit 熵） */
export function generateUserToken(): string {
  return "ut-" + randomBytes(36).toString("base64url");
}

/** login 防爆破判定：同 IP 每分钟最多 10 次，超限返回 false */
export function userTokenRateLimit(ip: string): boolean {
  return rateLimit(`ut-login:${ip}`, LOGIN_RATE_PER_MIN, 60_000);
}

/** /connect 授权签发防刷（2026-11-12）：同一用户每分钟最多签发 3 个 token，
 *  防脚本灌 user_token 表；正常用户不可能一分钟授权 3 次 */
export function connectRateLimit(uid: number): boolean {
  return rateLimit(`ut-connect:${uid}`, 3, 60_000);
}

/**
 * 签发用户 token（校验通过后调用）：
 * 落库 sha256 哈希 + 过期时刻，返回明文（仅此一次）。
 * ttlSeconds 缺省 7 天（login 口径）；/connect 授权页传 90 天。
 */
export async function issueUserToken(uid: number, ttlSeconds = USER_TOKEN_TTL): Promise<string> {
  const token = generateUserToken();
  const now = Math.floor(Date.now() / 1000);
  await prisma.userToken.create({
    data: {
      user: BigInt(uid),
      tokenHash: sha256(token),
      status: 1,
      createTime: BigInt(now),
      expireTime: BigInt(now + ttlSeconds),
    },
  });
  return token;
}

/**
 * 校验请求的 Bearer token（用户侧 API 用这个）：
 * sha256 查 user_token 表 → 过期/吊销/封禁 → null；
 * 命中返回 { uid, username, role }。
 */
export async function requireUserToken(req: Request): Promise<TokenRow | null> {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token || token.length > 128) return null;
  const h = sha256(token);
  const now = Date.now();

  const hit = cache.get(h);
  if (hit && now - hit.at < CACHE_TTL) return hit.ident;

  try {
    const row = await prisma.userToken.findUnique({ where: { tokenHash: h } });
    if (!row || row.status !== 1) return null;
    if (BigInt(row.expireTime) <= BigInt(Math.floor(Date.now() / 1000))) return null;

    // 封禁检查（与站内 getSession 同款兜底）：到期限时封禁节流清扫 + status=-1 拒绝。
    // username/role 在 user_auth 表（user.id 与之一一对应）
    await ensureBansLifted();
    const [user, auth] = await Promise.all([
      prisma.user.findUnique({ where: { id: row.user }, select: { status: true } }),
      prisma.userAuth.findUnique({ where: { id: row.user }, select: { username: true, role: true } }),
    ]);
    if (!user || user.status === -1 || !auth) return null;

    const ident: TokenRow = { uid: Number(row.user), username: auth.username, role: auth.role };
    cache.set(h, { ident, at: now });
    if (cache.size > 10000) cache.clear(); // 防膨胀：粗暴清空即可，误清只是多一次查库
    return ident;
  } catch {
    return null;
  }
}
