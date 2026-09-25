import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 蓝绿双槽构建产物隔离：server-deploy.sh 构建备槽时设 NEXT_DIST_DIR=.next-green/.next-blue，
  // pm2 两个进程（ecosystem.config.js env）各自启动时同样带上 → next build/start 都落到自己的目录。
  // ⚠️ Next.js 不认 NEXT_DIST_DIR 环境变量，必须在这里显式读取——漏掉此行会导致两个槽共用
  // .next，CI 每次构建覆盖运行中进程的磁盘产物，HTML 引用的 chunk 在磁盘上消失 → CSS/JS 全 500
  // （2026-09-25 new.saolei.wang 首日实踩，样式全丢即此因）
  distDir: process.env.NEXT_DIST_DIR || ".next",

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
