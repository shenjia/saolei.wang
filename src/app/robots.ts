// robots.txt（Next Metadata Route，构建期静态生成）
// 上线前 SEO 基础件（2026-10-15）：屏蔽后台/接口与登录态页面，放行全部公开内容页。
// 站点地址与 sitemap 一致取 SITE_URL（生产 .env 切主域时配 https://saolei.wang）。
// 2026-10-29 增补：AI 训练/数据采集爬虫全站禁抓（nginx 层已 403，此处为君子协定双保险，
// 守 robots 的（GPTBot/CCBot/Bytespider 等）会自查退出，省源站渲染）。
import type { MetadataRoute } from "next";

// 无引流价值的采集/AI 爬虫（2026-10-28 生产日志实测清单：合计 ~120 万请求/月）
const AI_BOTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", // OpenAI
  "ClaudeBot", "Claude-Web", "anthropic-ai", // Anthropic
  "meta-externalagent", "FacebookBot", // Meta
  "Google-Extended", "GoogleOther", // Google AI/内部（≠Googlebot）
  "Bytespider", // 字节
  "CCBot", // Common Crawl
  "Amazonbot", "Applebot-Extended", "PerplexityBot", "YouBot",
  "Diffbot", "PanguBot", "Xianguo", "SocketLabs",
  "SemrushBot", "AhrefsBot", "DataForSeoBot", "MJ12bot", "DotBot", // SEO 采集
  "Reflectionbot", "KeenableBot", "WebSiphon", "TLM-Audit-Scanner", "KakaoBot", // 数据公司
];

export default function robots(): MetadataRoute.Robots {
  const base = process.env.SITE_URL ?? "https://saolei.wang";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/", "/account/", "/message", "/bbs/post", "/bbs/edit/"],
      },
      ...AI_BOTS.map((ua) => ({
        userAgent: ua,
        disallow: "/", // 全站禁抓
      })),
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
