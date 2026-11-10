// 动态加载更多（移植 NewsController::actionMore / UserController::actionMoreNews）
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染
// 2026-10-14 二轮：加 page 页码语义（用户主页动态翻页条用；id 倒序 OFFSET，
//   与 cursor 语义并存——带 page 参数即走页码模式，返回该页起 size 条）

import { NextResponse } from "next/server";
import { getNews, getNewsCount, getNewsPage } from "@/lib/queries";
import { title as assessTitle, recordNewsExpTime } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";
import { getFeedSalts } from "@/lib/feedsalt";
import { NEWS_PAGESIZE, NEWS_TYPE } from "@/lib/config";
import { parseFeedStage } from "@/lib/stage";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const userId = parseInt(p.get("user") ?? "", 10) || undefined;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || NEWS_PAGESIZE, 100); // 2026-10-14 递增批量上限放宽（原 50）
  const lv = p.get("level") ?? "";
  const level = lv === "beg" || lv === "int" || lv === "exp" ? lv : undefined;
  // tab 筛选（2026-10-27 张老师定）：「发表」只看自己写的文章（ARTICLE），
  // 「评论」= 文章回帖 + 录像评论（COMMENT，两种 kind 都算）；与等级筛选互斥。
  // 旧值 forum（ARTICLE+COMMENT 合流）已随「论坛」tab 下线，仅客户端取数，无外链兼容负担
  const typeParam = p.get("type") ?? "";
  const types =
    typeParam === "post"
      ? [NEWS_TYPE.ARTICLE]
      : typeParam === "comment"
        ? [NEWS_TYPE.COMMENT]
        : undefined;
  // 首页新闻流口径（home=1）：仅 NEWS_HOME_TYPES，注册/头像/发帖/评论动态不进首页
  const home = p.get("home") === "1";
  // 首页阶段筛选（2026-10-29 张老师定）：gen/col/sol/god/man，按作者行内快照分档；
  // 仅首页 tabs 传此参数（用户主页不带），非法值回「全部」
  const stage = parseFeedStage(p.get("stage"));
  // 2026-11-06 张老师定：总司令=动态阈值档（快照快于阈值即评定，不再按身份特判）
  const kingTh = await getThunderKingThreshold();
  // 2026-11-09 登录态实时化：home 口径的「剩余条数」计数走缓存，服务端按 session 取盐
  // 与首页 SSR 同键（getNews 行查询本身无缓存恒实时，盐只影响 total 口径一致性）
  const homeSalt = home ? (await getFeedSalts()).news : "";

  // 页码模式（2026-10-14 用户主页动态翻页条）：?page=N 从头数第 N 页
  const pageRaw = parseInt(p.get("page") ?? "", 10);
  if (pageRaw >= 1) {
    const page = pageRaw;
    const base = p.get("base") ? parseInt(p.get("base") ?? "", 10) || NEWS_PAGESIZE : NEWS_PAGESIZE;
    const [items, total] = await Promise.all([
      getNewsPage({ types, userId, level, home, stage, page, base, limit: size }),
      getNewsCount({ types, userId, level, home, stage, ...(homeSalt ? { salt: homeSalt } : {}) }),
    ]);
    const withTitles = items.map((news) => ({
      news,
      title: assessTitle(recordNewsExpTime(news.expTime, news.details, news.videoRealTime), kingTh),
      classic: news.authorTitles?.c ?? null,
    }));
    return NextResponse.json({
      items: withTitles,
      cursor: items.length ? items[items.length - 1].id : 0,
      count: items.length,
      total,
    });
  }

  const [items, total] = await Promise.all([
    getNews({ types, userId, level, cursor: cursor || undefined, limit: size, home, stage }),
    // 同条件下的动态总数：「加载更多」括号内显示剩余条数用
    getNewsCount({ types, userId, level, home, stage, ...(homeSalt ? { salt: homeSalt } : {}) }),
  ]);
  const withTitles = items.map((news) => ({
    news,
    // videoRealTime 与页码模式同参（2026-11-10 补漏：cursor 模式此前漏传第三参，
    // 双破录像的 3bvs 纪录行军衔会按裸快照错档）
    title: assessTitle(recordNewsExpTime(news.expTime, news.details, news.videoRealTime), kingTh),
    classic: news.authorTitles?.c ?? null,
  }));
  return NextResponse.json({
    items: withTitles,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
