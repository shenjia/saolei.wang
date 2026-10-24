// robots.txt（Next Metadata Route，构建期静态生成）
// 上线前 SEO 基础件（2026-10-15）：屏蔽后台/接口与登录态页面，放行全部公开内容页。
// 站点地址与 sitemap 一致取 SITE_URL（生产 .env 切主域时配 https://saolei.wang）。
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.SITE_URL ?? "https://saolei.wang";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/", "/account/", "/message", "/bbs/post", "/bbs/edit/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
