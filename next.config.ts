import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dev 预览走 nginx 反代 https://dev.saolei.wang：
  // 不加此项时 next dev 会以 Origin 不匹配拒绝 /_next/hmr 的 WebSocket 握手（返回 Unauthorized），
  // Turbopack dev 客户端连不上 HMR 会卡住水合，页面所有交互（登录 tab 切换等）全部失效
  allowedDevOrigins: ["dev.saolei.wang"],
};

export default nextConfig;
