// 排行多地域选路探测端点（2026-10-28）：客户端进排行模式时并行探测本站与
// 各地域节点（香港等），选 RTT 最低者连 WS。只回一行 JSON，无 DB 无 session——
// 与各地域节点侧的 /ws/online/ranked-ping（Caddy 静态返回）同语义
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
