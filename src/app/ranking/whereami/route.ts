// 「我在哪里」定位（移植 RankingController::actionWhereAmI）
// GET /ranking/whereami?id=<uid>&level=sum&order=time → 302 到 /ranking?...&page=N#id_<uid>

import { NextRequest, NextResponse } from "next/server";
import { getRankingPageOfUser } from "@/lib/queries";
import { LEVELS, ORDERS, type Level, type Order } from "@/lib/config";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const id = parseInt(p.get("id") ?? "", 10);
  const level = (
    (LEVELS as readonly string[]).includes(p.get("level") ?? "") ? p.get("level") : "sum"
  ) as Level;
  const order = (
    (ORDERS as readonly string[]).includes(p.get("order") ?? "") ? p.get("order") : "time"
  ) as Order;

  const url = new URL("/ranking", req.url);
  url.searchParams.set("level", level);
  url.searchParams.set("order", order);

  if (id > 0) {
    const page = await getRankingPageOfUser(id, level, order);
    if (page > 0) {
      url.searchParams.set("page", String(page));
      url.hash = `id_${id}`;
    }
  }
  return NextResponse.redirect(url);
}
