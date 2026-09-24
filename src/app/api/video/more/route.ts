// 首页「最新录像」加载更多（2026-09-24 张老师要求，与 /api/news/more 同构）
// 按上传时间倒序的游标翻页；军衔称号在服务端预算好随 JSON 返回，客户端直接渲染。

import { NextResponse } from "next/server";
import { getVideoFeed, getVideoCount } from "@/lib/queries";
import { VIDEO_PAGESIZE, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || VIDEO_PAGESIZE, 50);
  const lv = p.get("level") ?? "";
  const level: VideoLevel | "all" = (VIDEO_LEVELS as readonly string[]).includes(lv)
    ? (lv as VideoLevel)
    : "all";

  const [items, total] = await Promise.all([
    getVideoFeed({ level, cursor: cursor || undefined, limit: size }),
    // 同条件下的录像总数：「加载更多」括号内显示剩余条数用
    getVideoCount({ level }),
  ]);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
