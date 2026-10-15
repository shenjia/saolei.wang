// 录像「加载更多」增量接口：
// ① 默认（游标 cursor+size+level）——首页「最新录像」版块（2026-09-24，与 /api/news/more 同构）
// ② 列表模式（page+level+order+author）——/video 列表页 + 用户主页录像版块，
//    与 getVideoList 的页码/筛选语义完全一致（复用同一查询，含成绩表排序切换）
// ③ 首页页码模式（feedPage+base+level，2026-10-14 四轮）——首页录像版块翻页条，
//    id 倒序按页取（getVideoFeedPage）；feedPage 与 ② 的 page 互不干扰
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染。

import { NextResponse } from "next/server";
import { getVideoFeed, getVideoFeedPage, getVideoCount, getVideoList } from "@/lib/queries";
import { VIDEO_PAGESIZE, VIDEO_LEVELS, parseVideoListOrder, type VideoLevel } from "@/lib/config";

function parseLevel(p: URLSearchParams): VideoLevel | "all" {
  const lv = p.get("level") ?? "";
  return (VIDEO_LEVELS as readonly string[]).includes(lv) ? (lv as VideoLevel) : "all";
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;

  // ② 列表模式：带 page 参数即走 getVideoList 页码语义
  const pageRaw = p.get("page");
  if (pageRaw) {
    const page = Math.max(2, parseInt(pageRaw, 10) || 2);
    const level = parseLevel(p);
    // 2026-10-15：排序列扩为表头点击全集（parseVideoListOrder），并透传时间成绩搜索
    const order = parseVideoListOrder(p.get("order") ?? undefined);
    const author = parseInt(p.get("author") ?? "", 10) || undefined;
    const time = p.get("time")?.trim() || undefined;
    // 每页条数：调用方自定义（用户主页录像版块传 10），默认 /video 列表的 20；
    // 上限 100（2026-10-14「加载更多」递增批量封顶放宽，原 50）
    const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
    const { videos, total, pageSize } = await getVideoList({ level, order, author, time, page, pageSize: size });
    return NextResponse.json({
      videos,
      total,
      hasMore: page * pageSize < total,
    });
  }

  // ③ 首页页码模式（feedPage）：id 倒序第 N 页起 size 条
  const feedPage = parseInt(p.get("feedPage") ?? "", 10);
  if (feedPage >= 1) {
    const level = parseLevel(p);
    const base = parseInt(p.get("base") ?? "", 10) || VIDEO_PAGESIZE;
    const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
    const [items, total] = await Promise.all([
      getVideoFeedPage({ level, page: feedPage, base, limit: size }),
      getVideoCount({ level }),
    ]);
    return NextResponse.json({
      items,
      cursor: items.length ? items[items.length - 1].id : 0,
      count: items.length,
      total,
    });
  }

  // ① 首页游标模式
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 100);
  const level = parseLevel(p);

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
