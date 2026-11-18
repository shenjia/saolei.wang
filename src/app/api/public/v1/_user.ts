// 公开 API · 用户侧端点共享工具（2026-11-19）
// 鉴权双闸（与 upload 同款）：
//   ① X-Api-Key：合作方 key 鉴权 + scope 闸 + 按 key 限速；
//   ② Authorization: Bearer <token>：用户 token（login 7 天 / connect 90 天），封禁联动。
// 身份一律从 Bearer token 推导（ident.uid）——不收客户端自报 userId，杜绝伪造。
//
// 现有用户侧端点（me / upload）均无 scope 闸（me）/ 有 scope 闸（upload）；
// 本批 6 端点沿用 upload 口径：需 scope=user（无 scope 列的 key 直接放行——
// 空 scopes = 全量授权，与 partnerScopeAllowed 空串放行语义一致，存量 key 无感）。

import { NextResponse } from "next/server";
import {
  requirePartnerEx,
  unauthorized,
  rateLimited,
  partnerRateLimit,
  partnerScopeAllowed,
  forbiddenScope,
  type PartnerIdentity,
} from "@/lib/partner";
import { requireUserToken } from "@/lib/usertoken";

export interface UserApiIdent {
  partner: PartnerIdentity;
  uid: number;
  username: string;
  role: number;
}

/** 双闸鉴权（partner key + scope=user + 用户 token）；失败返回 Response，成功返回 null */
export async function userApiAuth(
  req: Request
): Promise<{ ident: UserApiIdent } | { err: NextResponse }> {
  const partner = await requirePartnerEx(req);
  if (!partner) return { err: unauthorized() as unknown as NextResponse };
  if (!partnerScopeAllowed(partner, "user")) return { err: forbiddenScope("user") as unknown as NextResponse };
  if (!partnerRateLimit(partner, "user")) {
    return { err: rateLimited(partner.ratePerMin) as unknown as NextResponse };
  }
  const t = await requireUserToken(req);
  if (!t) {
    return {
      err: NextResponse.json(
        { error: "unauthorized", message: "缺少、无效或已过期的 Bearer token，请重新登录获取" },
        { status: 401 }
      ),
    };
  }
  return { ident: { partner, uid: t.uid, username: t.username, role: t.role } };
}

/** 解析 JSON 请求体；失败返回 {}（各端点自行校字段） */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 解析正整数参数（uid/id 类）；非法返回 0 */
export function parseIntParam(v: unknown): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 维护模式闸（写操作用；与站内同款响应形态） */
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";
export async function maintenanceGate(): Promise<NextResponse | null> {
  if (await isMaintenanceOn()) return maintenanceReject() as unknown as NextResponse;
  return null;
}
