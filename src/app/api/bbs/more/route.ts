// BBS 主题列表「加载更多」（页码语义；每页条数固定 BBS_PAGESIZE=19）
// 作者的军衔/称号在服务端预算好随 JSON 返回，客户端直接渲染
// 2026-09-25 六轮：与 /bbs 页对齐——「精华」= board=nice（跨板块），排序固定更新时间；
//   ?nice=1 / ?order=nice 旧深链兼容；order 参数作废

import { NextResponse } from "next/server";
import { BBS_BOARD_NAMES, getPostPage } from "@/lib/bbs";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(2, parseInt(p.get("page") ?? "2", 10) || 2);
  const nice = p.get("nice") === "1" || p.get("order") === "nice" || p.get("board") === "nice";
  const boardRaw = parseInt(p.get("board") ?? "", 10);
  const board = !nice && BBS_BOARD_NAMES[boardRaw] !== undefined ? boardRaw : undefined;

  const { posts, hasMore, total } = await getPostPage({
    board,
    order: "reply",
    nice: nice || undefined,
    page,
  });
  return NextResponse.json({ posts, hasMore, total });
}
