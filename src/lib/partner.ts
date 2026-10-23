// 对外公开 API 鉴权（2026-10-24 重构：env key 草案 → api_key 表落库管理）
//
// 背景：2026-10-21 的 partner API 是草案形态（key 配在 .env），未实际投入使用。
// 现升级为对外公开 API 体系（/api/public/v1/*），key 由管理后台创建、落 api_key 表：
//   · key 明文格式 sk-<40 位随机>，只存 sha256 哈希，明文仅创建时回显一次
//   · 校验走 sha256 后等值查表（哈希等长，索引命中即通过，无需恒时比较）
//   · 内存缓存 30s：key 表变更（吊销）最迟 30s 生效；request_count 异步累加不阻塞响应
//   · 兼容期：env PARTNER_API_KEYS 仍可用（老草案 key 不至于全断），查库优先
//
// 限速：沿用 lib/ratelimit.ts 进程内滑动窗口，60 次/分/合作方（各接口独立维度）。

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";

/** 内存缓存：hash → { name, keyId }，30s 过期（吊销最迟 30s 生效） */
const cache = new Map<string, { name: string; keyId: number; at: number }>();
const CACHE_TTL = 30_000;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 生成新 key 明文：sk- + 40 位 URL 安全随机（≈240bit 熵） */
export function generateApiKey(): string {
  return "sk-" + randomBytes(30).toString("base64url");
}

/** 环境兼容：解析 env 里的草案 key 表（"<key>=<合作方>" 逗号分隔） */
function envPartnerName(key: string): string | null {
  const raw = process.env.PARTNER_API_KEYS ?? "";
  for (const pair of raw.split(",")) {
    const eq = pair.lastIndexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === key) return pair.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * 校验请求的 X-Api-Key（异步，路由请用这个）：
 * ①sha256 → 查 api_key 表（缓存 30s）；②未命中再走 env 兼容草案 key。
 * 通过返回合作方标识（限速/日志维度），否则 null。
 * 命中即异步累计 request_count / last_used_at（失败忽略，不阻塞主流程）。
 */
export async function requirePartner(req: Request): Promise<string | null> {
  const provided = req.headers.get("x-api-key")?.trim() ?? "";
  if (!provided) return null;
  const h = sha256(provided);
  const now = Date.now();

  const hit = cache.get(h);
  if (hit && now - hit.at < CACHE_TTL) {
    void touchUsage(hit.keyId);
    return hit.name;
  }

  try {
    const row = await prisma.apiKey.findUnique({ where: { keyHash: h } });
    if (row && row.status === 1) {
      cache.set(h, { name: row.name, keyId: Number(row.id), at: now });
      void touchUsage(Number(row.id));
      return row.name;
    }
  } catch {
    /* 查库异常走 env 兜底 */
  }
  return envPartnerName(provided);
}

/** 用量累计：异步 fire-and-forget，失败不影响请求 */
function touchUsage(keyId: number): void {
  const ts = BigInt(Math.floor(Date.now() / 1000));
  void prisma.apiKey
    .update({
      where: { id: BigInt(keyId) },
      data: { requestCount: { increment: 1 }, lastUsedAt: ts },
    })
    .catch(() => {});
}

/** 统一的 401 响应（不透露 key 是否存在） */
export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "缺少或无效的 X-Api-Key。数据接入请通过官方 API，联系站点管理员获取 key。" }),
    { status: 401, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/** 统一的 429 响应 */
export function rateLimited(): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "请求过频，请降低频率（限 60 次/分钟）" }),
    { status: 429, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/** 吊销/新建后清缓存，让变更立即生效 */
export function invalidateApiKeyCache(): void {
  cache.clear();
}
