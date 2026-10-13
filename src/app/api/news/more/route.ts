// 动态加载更多（移植 NewsController::actionMore / UserController::actionMoreNews）
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染

import { NextResponse } from "next/server";
import { getNews, getNewsCount } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { NEWS_PAGESIZE, NEWS_TYPE } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const userId = parseInt(p.get("user") ?? "", 10) || undefined;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || NEWS_PAGESIZE, 50);
  const lv = p.get("level") ?? "";
  const level = lv === "beg" || lv === "int" || lv === "exp" ? lv : undefined;
  // 论坛筛选（2026-10-13 张老师要求）：发表主题（ARTICLE）+ 评论（COMMENT）都算，与等级筛选互斥
  const types = p.get("type") === "forum" ? [NEWS_TYPE.ARTICLE, NEWS_TYPE.COMMENT] : undefined;
  // 首页新闻流口径（home=1）：仅 NEWS_HOME_TYPES，注册/头像/发帖/评论动态不进首页
  const home = p.get("home") === "1";

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
