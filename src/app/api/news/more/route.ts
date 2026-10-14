// 动态加载更多（移植 NewsController::actionMore / UserController::actionMoreNews）
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染
// 2026-10-14 二轮：加 page 页码语义（用户主页动态翻页条用；id 倒序 OFFSET，
//   与 cursor 语义并存——带 page 参数即走页码模式，返回该页起 size 条）

import { NextResponse } from "next/server";
import { getNews, getNewsCount, getNewsPage } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { NEWS_PAGESIZE, NEWS_TYPE } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const userId = parseInt(p.get("user") ?? "", 10) || undefined;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || NEWS_PAGESIZE, 100); // 2026-10-14 递增批量上限放宽（原 50）
  const lv = p.get("level") ?? "";
  const level = lv === "beg" || lv === "int" || lv === "exp" ? lv : undefined;
  // 论坛筛选（2026-10-13 张老师要求）：发表主题（ARTICLE）+ 评论（COMMENT）都算，与等级筛选互斥
  const types = p.get("type") === "forum" ? [NEWS_TYPE.ARTICLE, NEWS_TYPE.COMMENT] : undefined;
  // 首页新闻流口径（home=1）：仅 NEWS_HOME_TYPES，注册/头像/发帖/评论动态不进首页
  const home = p.get("home") === "1";

  // 页码模式（2026-10-14 用户主页动态翻页条）：?page=N 从头数第 N 页
  const pageRaw = parseInt(p.get("page") ?? "", 10);
  if (pageRaw >= 1) {
    const page = pageRaw;
    const base = p.get("base") ? parseInt(p.get("base") ?? "", 10) || NEWS_PAGESIZE : NEWS_PAGESIZE;
    const [items, total] = await Promise.all([
      getNewsPage({ types, userId, level, home, page, base, limit: size }),
      getNewsCount({ types, userId, level, home }),
    ]);
    const withTitles = items.map((news) => ({ news, title: assessTitle(news.expTime) }));
    return NextResponse.json({
      items: withTitles,
      cursor: items.length ? items[items.length - 1].id : 0,
      count: items.length,
      total,
    });
  }

  const [items, total] = await Promise.all([
    getNews({ types, userId, level, cursor: cursor || undefined, limit: size, home }),
    // 同条件下的动态总数：「加载更多」括号内显示剩余条数用
    getNewsCount({ types, userId, level, home }),
  ]);
  const withTitles = items.map((news) => ({ news, title: assessTitle(news.expTime) }));
  return NextResponse.json({
    items: withTitles,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
