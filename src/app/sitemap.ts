// sitemap.xml（Next Metadata Route，构建期静态生成）
// 上线前 SEO 基础件（2026-10-15）：
//   只放「稳定入口页」——排行榜/录像列表/论坛/帮助/静态页/练习页等，每日全量重生成。
//   30 万录像详情、3.5 万用户主页是动态深水区，刻意不放（页面随构建每日刷新一次足够，
//   搜索引擎沿站内链接自然发现；全量塞进 sitemap 反而稀释权重、生成开销也大）。
//   列表类页面带筛选参数形态（?view=world 等）时只放规范形态（无参或主参数），
//   避免与 Canonical 语义打架。
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.SITE_URL ?? "https://saolei.wang";
  const now = new Date();
  const page = (path: string, priority = 0.5, changeFrequency: "daily" | "weekly" | "monthly" = "weekly") => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });

  return [
    page("/", 1.0, "daily"),
    // 排行域
    page("/ranking", 0.9, "daily"),
    page("/ranking?view=nf", 0.6),
    page("/ranking?view=bv", 0.6),
    page("/ranking?view=world", 0.7, "daily"),
    page("/area", 0.7, "weekly"),
    page("/grow", 0.6, "daily"),
    page("/titles", 0.6),
    // 录像域
    page("/video", 0.9, "daily"),
    page("/video/upload", 0.4, "monthly"),
    // 论坛
    page("/bbs", 0.8, "daily"),
    page("/bbs?board=1", 0.5),
    page("/bbs?board=2", 0.5),
    page("/bbs?board=3", 0.5),
    // 练习
    page("/online", 0.8, "weekly"),
    // 用户域公开页
    page("/team", 0.4, "monthly"),
    page("/user/random", 0.3, "monthly"),
    // 帮助与静态页
    page("/page/help", 0.6, "monthly"),
    page("/page/help/why", 0.5, "monthly"),
    page("/page/help/grow", 0.5, "monthly"),
    page("/page/help/word", 0.5, "monthly"),
    page("/page/help/video", 0.5, "monthly"),
    page("/page/help/upload", 0.5, "monthly"),
    page("/page/help/freeze", 0.5, "monthly"),
    page("/page/help/bbs", 0.5, "monthly"),
    page("/page/help/email", 0.5, "monthly"),
    page("/page/help/avatar", 0.5, "monthly"),
    page("/page/help/clone-faq", 0.5, "monthly"),
    page("/page/titles", 0.5, "monthly"),
    page("/page/guide", 0.6, "monthly"),
    page("/page/download", 0.6, "monthly"),
    page("/page/world", 0.5, "monthly"),
    page("/page/about", 0.4, "monthly"),
    page("/page/donate", 0.4, "monthly"),
    page("/page/history", 0.4, "monthly"),
  ];
}
