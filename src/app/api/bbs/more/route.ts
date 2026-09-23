// BBS 主题列表「加载更多」（页码语义；每页条数固定 BBS_PAGESIZE=19）
// 作者的军衔/称号在服务端预算好随 JSON 返回，客户端直接渲染

import { NextResponse } from "next/server";
import { BBS_BOARD_NAMES, getPostPage, type BbsOrder } from "@/lib/bbs";

const ORDERS: readonly BbsOrder[] = ["reply", "post"];

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = Math.max(2, parseInt(p.get("page") ?? "2", 10) || 2);
  const boardRaw = parseInt(p.get("board") ?? "", 10);
  const board = BBS_BOARD_NAMES[boardRaw] !== undefined ? boardRaw : undefined;
  const orderRaw = p.get("order") ?? "";
  // order=nice = 只看精华（固定更新时间排序，2026-09-24 四轮）；?nice=1 旧深链兼容
  const nice = p.get("nice") === "1" || orderRaw === "nice";
  const order: BbsOrder = !nice && ORDERS.includes(orderRaw as BbsOrder) ? (orderRaw as BbsOrder) : "reply";

  const { posts, hasMore } = await getPostPage({ board, order, nice: nice || undefined, page });
  return NextResponse.json({ posts, hasMore });
}
