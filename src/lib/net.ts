// 请求方真实 IP（2026-10-19 防小号系列）
// 生产走 nginx 反代，客户端 IP 在 x-forwarded-for 首段；本地 dev 直连则看 socket 地址由 Next 提供（此处取不到，回退空串）

export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 45) : "";
}
