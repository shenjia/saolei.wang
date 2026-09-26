// 录像「加载更多」增量接口：
// ① 默认（游标 cursor+size+level）——首页「最新录像」版块（2026-09-24，与 /api/news/more 同构）
// ② 列表模式（page+level+order+author）——/video 列表页老式翻页改加载更多（同日张老师要求），
//    与 getVideoList 的页码/筛选语义完全一致（复用同一查询，含成绩表排序切换）
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染。

import { NextResponse } from "next/server";
import { getVideoFeed, getVideoCount, getVideoList } from "@/lib/queries";
import { VIDEO_PAGESIZE, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;

  // ② 列表模式：带 page 参数即走 getVideoList 页码语义
  const pageRaw = p.get("page");
  if (pageRaw) {
    const page = Math.max(2, parseInt(pageRaw, 10) || 2);
    const lv = p.get("level") ?? "";
    const level: VideoLevel | "all" = (VIDEO_LEVELS as readonly string[]).includes(lv)
      ? (lv as VideoLevel)
      : "all";
    const orderRaw = p.get("order") ?? "id";
    const order =
      orderRaw === "time" || orderRaw === "3bvs" || orderRaw === "comments" || orderRaw === "clicks"
        ? orderRaw
        : "id";
    const author = parseInt(p.get("author") ?? "", 10) || undefined;
    // 每页条数：调用方自定义（用户主页录像版块传 10），默认 /video 列表的 20
    const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 50);
    const { videos, total, pageSize } = await getVideoList({ level, order, author, page, pageSize: size });
    return NextResponse.json({
      videos,
      total,
      hasMore: page * pageSize < total,
    });
  }

  // ① 首页游标模式
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 50);
  const lv = p.get("level") ?? "";
  const level: VideoLevel | "all" = (VIDEO_LEVELS as readonly string[]).includes(lv)
    ? (lv as VideoLevel)
    : "all";

  const [items, total] = await Promise.all([
    getVideoFeed({ level, cursor: cursor || undefined, limit: size }),
    // 同条件下的录像总数（左下角总数行）
    getVideoCount({ level }),
  ]);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
