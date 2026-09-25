import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dev 预览走 nginx 反代 https://dev.saolei.wang：
  // 不加此项时 next dev 会以 Origin 不匹配拒绝 /_next/hmr 的 WebSocket 握手（返回 Unauthorized），
  // Turbopack dev 客户端连不上 HMR 会卡住水合，页面所有交互（登录 tab 切换等）全部失效
  allowedDevOrigins: ["dev.saolei.wang"],

  // 旧站 301 跳转（src/proxy.ts）需要看到「客户端发来的原始 URL」：
  // 默认 Next 会规范化 URL，旧站 GBK 编码的查询串（如 ?Area=%C9%CF%BA%A3=上海）
  // 会被按 UTF-8 强解，无效字节替换成 U+FFFD 后重编码——原始 GBK 字节直接丢失、无法还原。
  // 开启此项后 proxy 拿到的 req.url 保持原始形态，GBK 参数才能正确解码跳转
  skipProxyUrlNormalize: true,
};

export default nextConfig;
