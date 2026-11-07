// 对外公开 API 鉴权（2026-10-24 重构：env key 草案 → api_key 表落库管理）
//
// 背景：2026-10-21 的 partner API 是草案形态（key 配在 .env），未实际投入使用。
// 现升级为对外公开 API 体系（/api/public/v1/*），key 由管理后台创建、落 api_key 表：
//   · key 明文格式 sk-<40 位随机>，只存 sha256 哈希，明文仅创建时回显一次
//   · 校验走 sha256 后等值查表（哈希等长，索引命中即通过，无需恒时比较）
//   · 内存缓存 30s：key 表变更（吊销）最迟 30s 生效；request_count 异步累加不阻塞响应
//   · 兼容期：env PARTNER_API_KEYS 仍可用（老草案 key 不至于全断），查库优先
//
// 限速：沿用 lib/ratelimit.ts 进程内滑动窗口，窗口 60s；上限按 key 各自配置
//（api_key.rate_per_min，默认 60，0=不限速；2026-11-07 起支持手动个别限速），各接口独立维度。
//
// 2026-10-25 新增分时用量：鉴权通过即按 +08:00 小时桶 × 接口短名 UPSERT api_key_usage
// （env 草案 key 记 key=0），/admin/apikeys 据此画今日调用走势折线图与合作方分接口统计；
// fire-and-forget，失败不影响请求。

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";

/** 未配置限速的 key（含 env 草案 key）的默认上限 */
export const DEFAULT_API_RATE_PER_MIN = 60;

/** 内存缓存：hash → { name, keyId, logo, ratePerMin }，30s 过期（吊销/限速变更最迟 30s 生效） */
const cache = new Map<
  string,
  { name: string; keyId: number; logo: string; ratePerMin: number; at: number }
>();
const CACHE_TTL = 30_000;

/** 鉴权完整结果：requirePartner 只要 name，需要 keyId/logo 的路由（如 video_list
 *  按调用方过滤自家来源录像、外站同步落库打来源标）用 requirePartnerEx */
export interface PartnerIdentity {
  name: string;
  /** api_key.id；env 草案 key 为 0 */
  keyId: number;
  /** api_key.logo，未配置为空串 */
  logo: string;
  /** 每分钟请求上限（api_key.rate_per_min，0=不限速）；env 草案 key 走默认 60 */
  ratePerMin: number;
}

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
  const id = await requirePartnerEx(req);
  return id ? id.name : null;
}

/** 完整版鉴权（2026-11-07）：在 requirePartner 基础上多返回 keyId 与 logo。
 *  keyId 供 video_list 过滤调用方自家来源录像（防同步递归）、外站同步落库打 from_site 标；
 *  logo 供详情页展示「来自XX」站点小图标。 */
export async function requirePartnerEx(req: Request): Promise<PartnerIdentity | null> {
  const provided = req.headers.get("x-api-key")?.trim() ?? "";
  if (!provided) return null;
  const h = sha256(provided);
  const now = Date.now();
  // 接口短名（/api/public/v1/stats?x=1 → stats；路径不匹配记空串，聚合时归「其他/未知」）
  const m = req.url.match(/\/api\/public\/v1\/([a-z_]+)/);
  const endpoint = m ? m[1] : "";

  const hit = cache.get(h);
  if (hit && now - hit.at < CACHE_TTL) {
    void touchUsage(hit.keyId, endpoint);
    return { name: hit.name, keyId: hit.keyId, logo: hit.logo, ratePerMin: hit.ratePerMin };
  }

  try {
    const row = await prisma.apiKey.findUnique({ where: { keyHash: h } });
    if (row && row.status === 1) {
      const ident: PartnerIdentity = {
        name: row.name,
        keyId: Number(row.id),
        logo: row.logo ?? "",
        ratePerMin: row.ratePerMin,
      };
      cache.set(h, { ...ident, at: now });
      void touchUsage(ident.keyId, endpoint);
      return ident;
    }
  } catch {
    /* 查库异常走 env 兜底 */
  }
  const envName = envPartnerName(provided);
  // env 草案 key 也记用量（key=0），今日走势图才能覆盖过渡期流量
  if (envName) void bumpUsage(0, Math.floor(Date.now() / 1000), endpoint);
  return envName ? { name: envName, keyId: 0, logo: "", ratePerMin: DEFAULT_API_RATE_PER_MIN } : null;
}

/**
 * 合作方维度限速判定（2026-11-07）：窗口 60s，上限取该 key 的 rate_per_min
 *（0=不限速直接放行），各接口独立维度。返回 false=超限，路由应回 429。
 */
export function partnerRateLimit(p: PartnerIdentity, dim: string): boolean {
  if (p.ratePerMin <= 0) return true;
  return rateLimit(`${dim}:${p.name}`, p.ratePerMin, 60_000);
}

/** 用量累计：异步 fire-and-forget，失败不影响请求 */
function touchUsage(keyId: number, endpoint: string): void {
  const now = Math.floor(Date.now() / 1000);
  const ts = BigInt(now);
  void prisma.apiKey
    .update({
      where: { id: BigInt(keyId) },
      data: { requestCount: { increment: 1 }, lastUsedAt: ts },
    })
    .catch(() => {});
  void bumpUsage(keyId, now, endpoint);
}

/** 分时用量（2026-10-25）：按 +08:00 小时桶 × 接口 UPSERT 累加，供 /admin/apikeys 走势图与详情页 */
function bumpUsage(keyId: number, now: number, endpoint: string): void {
  const hour = BigInt(Math.floor((now + 28800) / 3600));
  void prisma.$executeRaw`
    INSERT INTO api_key_usage (\`key\`, hour, endpoint, calls, update_time)
    VALUES (${keyId}, ${hour}, ${endpoint}, 1, ${now})
    ON DUPLICATE KEY UPDATE calls = calls + 1, update_time = ${now}
  `.catch(() => {});
}

/** 统一的 401 响应（不透露 key 是否存在） */
export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "缺少或无效的 X-Api-Key。数据接入请通过官方 API，联系站点管理员获取 key。" }),
    { status: 401, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/** 统一的 429 响应（limit 用于文案；不传按默认 60） */
export function rateLimited(limit?: number): Response {
  const shown = limit && limit > 0 ? limit : DEFAULT_API_RATE_PER_MIN;
  return new Response(
    JSON.stringify({ error: "rate_limited", message: `请求过频，请降低频率（限 ${shown} 次/分钟）` }),
    { status: 429, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/** 吊销/新建后清缓存，让变更立即生效 */
export function invalidateApiKeyCache(): void {
  cache.clear();
}
