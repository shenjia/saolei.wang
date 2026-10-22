// BBS 主题列表「加载更多」（页码语义；每页条数固定 BBS_PAGESIZE=19）
// 作者的军衔/称号在服务端预算好随 JSON 返回，客户端直接渲染
// 2026-09-25 六轮：与 /bbs 页对齐——「精华」= board=nice（跨板块），排序固定更新时间；
//   ?nice=1 / ?order=nice 旧深链兼容；order 参数作废
// 2026-09-26：透传 q 搜索关键字（标题或人名过滤，与 /bbs 页同语义）
// size（2026-10-14 递增批量）：本批行数，skip 恒按 19/页锚点；不传=一页 19。
// 2026-10-22：精华改正交开关（对齐录像页 NF）——nice=1 与 board 叠加
//   （board=1&nice=1=技术区精华）；旧形态 board=nice 兼容视为 nice 开启（board 剥掉）。

import { NextResponse } from "next/server";
import { BBS_BOARD_NAMES, getPostPage } from "@/lib/bbs";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  // page 放行 1（2026-10-22，同 /api/video/more 先例）：原钳 ≥2——「加载更多」
  // 首页恒来自服务端渲染；精华开关（BbsSection）切换需就地拉第 1 页整表替换。
  // 既有调用方（加载更多/滑条）只传 ≥2，行为不变
  const page = Math.max(1, parseInt(p.get("page") ?? "2", 10) || 1);
  const q = (p.get("q") ?? "").trim().slice(0, 30);
  const nice = !q && (p.get("nice") === "1" || p.get("order") === "nice" || p.get("board") === "nice");
  const boardRaw = parseInt(p.get("board") ?? "", 10);
  const board = BBS_BOARD_NAMES[boardRaw] !== undefined ? boardRaw : undefined;
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 19, 19), 100);

  const { posts, hasMore, total } = await getPostPage({
    board: q ? undefined : board,
    order: "reply",
    nice: q ? undefined : nice || undefined,
    q: q || undefined,
    page,
    take: sizeRaw ? size : undefined,
  });
  return NextResponse.json({ posts, hasMore, total });
}
