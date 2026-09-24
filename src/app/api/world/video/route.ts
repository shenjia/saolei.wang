// 世界排行录像代理（2026-09-24 张老师要求：点击世界榜成绩直接播放原站录像）：
// 原站 minesweepergame.com/member/file/{pid}/{文件} 直链无 CORS 头，浏览器端跨域 fetch 会被拦，
// 由本路由服务端转发（带原站要求的 UA+Referer），对站内播放器变成同源资源。
// GET /api/world/video?pid=7872&f=7872-Time-88-NF-0,490-3-20200131.avf

import { WORLD_FILE_BASE } from "@/lib/worldtop";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const pid = p.get("pid") ?? "";
  const f = p.get("f") ?? "";

  // 严格白名单校验：pid 纯数字、文件名仅允许原站命名字符（字母数字、逗号、点、连字符、下划线）
  // 且必须是录像后缀（avf/mvf/mvr——flop 播放器三种都支持），拼拒路径穿越/协议注入
  if (!/^\d+$/.test(pid) || !/^[\w.,-]+$/.test(f) || !/\.(avf|mvf|mvr)$/.test(f)) {
    return new Response("bad request", { status: 400 });
  }

  const upstream = await fetch(`${WORLD_FILE_BASE}/${pid}/${encodeURIComponent(f)}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: "https://minesweepergame.com/",
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("upstream error", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=86400", // 纪录文件不变，缓存 1 天
    },
  });
}
