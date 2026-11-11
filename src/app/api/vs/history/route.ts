// 历史对决分页（2026-11-11 15:48 张老师：对决页历史板块改全站通用
// 「加载更多 + 页码滑条」翻页器，客户端追加/跳页走本 API）。
import { NextResponse } from "next/server";
import { getVsHistory } from "@/lib/vs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const l = parseInt(sp.get("l") ?? "", 10);
  const r = parseInt(sp.get("r") ?? "", 10);
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  // r=0 合法：单边场景（竞技场只选了一人）按该玩家发起的记录查（17:23 张老师：
  // /vs/{id} 入口也要显示历史对决）——IN (l, r) 归一化成 IN (l, l)
  if (!l || Number.isNaN(l) || Number.isNaN(r)) {
    return NextResponse.json({ error: "bad_params" }, { status: 400 });
  }
  const hist = await getVsHistory(l, r || l, page, 10);
  return NextResponse.json(hist);
}
