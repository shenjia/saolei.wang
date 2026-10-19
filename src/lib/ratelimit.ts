// 进程内滑动窗口限速（2026-10-19 防小号系列）
// 单实例部署（pm2 fork），内存 Map 即可；重启清零可接受——只做实时防刷，不做审计

const buckets = new Map<string, number[]>();

/** key 维度滑动窗口：windowMs 内最多 max 次，超限返回 false */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  // 防止 Map 无限膨胀：超过 1 万个 key 时清一把过期
  if (buckets.size > 10000) {
    for (const [k, ts] of buckets) {
      if (ts.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return true;
}
