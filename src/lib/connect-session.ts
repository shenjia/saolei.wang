// /connect 设备授权流会话（2026-11-12 元扫雷 device flow，张老师方案）
//
// 流程（对照 connect_session 表注释）：
//   ① APP → POST /api/public/v1/connect/start（X-Api-Key）→ createConnectSession
//      生成高熵 code（cs- + 48 位随机 ≈288bit 熵），库中只存 sha256；
//   ② 用户在 /connect?app=meta&code=xxx 点「允许」→ approveConnectSession
//      （status 0→1 + 写 uid，不签发 token）；
//   ③ APP 每 interval 秒轮询 poll → pollConnectSession：status=1 时
//      原子消费（updateMany status=1→3 抢占成功才继续）→ 签发 90 天
//      user_token（issueUserToken，库里仍只有 hash）→ 明文随响应返回一次。
//
// 安全口径：
// · code 只存 sha256——库被拖走也无法伪造轮询/诱导授权；
// · poll 签发走「原子置 3」抢占，并发双取只有一个成功（防重放双签发）；
// · 会话短寿命（默认 10 分钟），过期后一切动作作废；
// · start/poll 校验同源 partner（api_key.name），A key 发起的会话 B key 查不到；
// · client_ip 落库供授权页做「异地发起」警告（防钓鱼转发 code）。

import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/partner";
import { issueUserToken } from "@/lib/usertoken";
import type { ConnectApp } from "@/lib/connect-apps";

/** 会话寿命（秒）：发起后用户有 10 分钟完成授权 */
export const CONNECT_SESSION_TTL = 600;

/** poll 接口建议轮询间隔（秒），随 start 响应下发 */
export const CONNECT_POLL_INTERVAL = 5;

/** 生成新 code 明文：cs- + 48 位 URL 安全随机（≈288bit 熵） */
export function generateConnectCode(): string {
  return "cs-" + randomBytes(36).toString("base64url");
}

/** 当前 Unix 秒 */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * ① 发起授权会话：生成 code、落库 pending，返回 { code, expireAt }。
 * 明文 code 仅此次返回（随后库中只有 sha256）。
 */
export async function createConnectSession(
  appKey: string,
  partner: string,
  clientIp: string
): Promise<{ code: string; expireAt: number }> {
  const code = generateConnectCode();
  const now = nowSec();
  await prisma.connectSession.create({
    data: {
      codeHash: sha256(code),
      appKey,
      partner,
      status: 0,
      clientIp,
      createTime: BigInt(now),
      expireTime: BigInt(now + CONNECT_SESSION_TTL),
    },
  });
  return { code, expireAt: now + CONNECT_SESSION_TTL };
}

/** 查会话（内部/授权页用）：找不到或已过期返回 null */
export async function findConnectSession(code: string) {
  if (!code || code.length > 128) return null;
  const row = await prisma.connectSession.findUnique({ where: { codeHash: sha256(code) } });
  if (!row) return null;
  if (BigInt(row.expireTime) <= BigInt(nowSec())) return null;
  return row;
}

/**
 * ② 用户点「允许」：status 0→1 + 写 uid（不签发 token，等 poll 首拉时签发）。
 * deny=true 时置 2（用户拒绝/反钓鱼）。
 * 返回 false = 会话不存在/已过期/状态已流转（幂等重复点按允许也走这里）。
 */
export async function approveConnectSession(code: string, uid: number, deny = false): Promise<boolean> {
  const res = await prisma.connectSession.updateMany({
    where: { codeHash: sha256(code), status: 0 },
    data: { status: deny ? 2 : 1, uid: BigInt(uid) },
  });
  return res.count > 0;
}

/** poll 响应形态 */
export interface ConnectPollResult {
  status: "pending" | "authorized" | "denied" | "consumed" | "invalid" | "expired";
  /** authorized 时随响应出现一次 */
  token?: string;
  tokenType?: "Bearer";
  /** token 有效期（秒） */
  expiresIn?: number;
  uid?: number;
  username?: string;
}

/**
 * ③ APP 轮询：同源 partner 校验 + 状态机 + 原子消费签发。
 * · status=1 → updateMany 抢占（1→3）成功才签发 token（并发双取只中一个）；
 * · 返回 invalid=code 不存在；expired=会话过期；consumed=已被拉走过（重放）。
 */
export async function pollConnectSession(
  code: string,
  partner: string,
  app: ConnectApp
): Promise<ConnectPollResult> {
  if (!code || code.length > 128) return { status: "invalid" };
  const row = await prisma.connectSession.findUnique({ where: { codeHash: sha256(code) } });
  if (!row || row.partner !== partner) return { status: "invalid" };
  if (BigInt(row.expireTime) <= BigInt(nowSec())) return { status: "expired" };

  if (row.status === 0) return { status: "pending" };
  if (row.status === 2) return { status: "denied" };

  if (row.status === 1) {
    // 原子消费：抢占成功（count=1）才签发，并发第二次 poll 直接走 consumed 分支
    const grab = await prisma.connectSession.updateMany({
      where: { codeHash: sha256(code), status: 1 },
      data: { status: 3, consumeTime: BigInt(nowSec()) },
    });
    if (grab.count === 0) return { status: "consumed" };

    const uid = Number(row.uid);
    const token = await issueUserToken(uid, app.tokenTtl);
    const auth = await prisma.userAuth.findUnique({
      where: { id: BigInt(uid) },
      select: { username: true },
    });
    return {
      status: "authorized",
      token,
      tokenType: "Bearer",
      expiresIn: app.tokenTtl,
      uid,
      username: auth?.username ?? "",
    };
  }

  return { status: "consumed" };
}
