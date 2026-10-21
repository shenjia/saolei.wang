// 合作站点数据同步 API 鉴权（2026-10-21 张老师决策：反爬 + 给可信站点提供官方数据通道）
// 背景：旧版网站被第三方爬得体无完肤；与其被爬，不如给可信站点（首批 openms.top）
// 提供带 key 的结构化 API，同时 nginx 侧对裸爬做限速/UA 过滤（见部署侧配置）。
//
// 鉴权方式：请求头 X-Api-Key: <key>
// key 配置在 .env 的 PARTNER_API_KEYS，格式："<key>=<合作方标识>" 逗号分隔多项，例如
//   PARTNER_API_KEYS=9f1c...=openms.top,3ab7...=partner2.example.com
// 合作方标识用于限速维度与日志（不外发）。
//
// 安全细节：
//  - 用 timingSafeEqual 恒时比较，防时序侧信道逐字节猜 key
//  - key 长度先比对（长度不同直接失败，不进入恒时比较——恒时比较要求等长）
//  - env 未配置时一律 401（不会因为漏配而裸开放）

import { timingSafeEqual } from "crypto";

/** 解析 env 里的 key 表（启动后每次调用都重新解析：pm2 --update-env 后无需重启代码逻辑） */
function parseKeys(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.PARTNER_API_KEYS ?? "";
  for (const pair of raw.split(",")) {
    const eq = pair.lastIndexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const partner = pair.slice(eq + 1).trim();
    if (key && partner) map.set(key, partner);
  }
  return map;
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** 校验请求的 X-Api-Key；通过返回合作方标识，否则 null */
export function requirePartner(req: Request): string | null {
  const provided = req.headers.get("x-api-key")?.trim() ?? "";
  if (!provided) return null;
  for (const [key, partner] of parseKeys()) {
    if (safeEq(provided, key)) return partner;
  }
  return null;
}

/** 统一的 401 响应（不透露 key 是否存在） */
export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "缺少或无效的 X-Api-Key。数据同步请通过官方 API 接入，联系站点管理员获取 key。" }),
    { status: 401, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
