// 「我在哪里」查找定位（移植 2008 版 Ranking/Goto：按姓名或 ID 定位到对应页锚点）
// GET /ranking/whereami?id=<uid>&name=<姓名>&q=<姓名或ID>&view=all|nf&by=<排序列>
//   &format=json → { page }（底部「我在哪里」按钮轻量探测页码用）
// → 302 到 /ranking?...&page=N#id_<uid>；兼容旧参数 level/order/nf/name/id
// 2026-09-24：新增合并搜索框参数 q（纯数字按 ID、否则按姓名），原 name/id 仍可用

import { NextRequest, NextResponse } from "next/server";
import { findUserByName, getRankingPageOfUser } from "@/lib/queries";
import { byLevelOrder, parseRankingBy, LEVELS, ORDERS, type Level, type Order } from "@/lib/config";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  // 目标用户：id 优先，其次 q（纯数字当 ID、否则姓名），再次旧参数 name
  let id = parseInt(p.get("id") ?? "", 10) || 0;
  if (!id) {
    const q = (p.get("q") ?? "").trim();
    if (q) id = /^\d{1,7}$/.test(q) ? parseInt(q, 10) : (await findUserByName(q)) ?? 0;
  }
  if (!id) {
    const name = (p.get("name") ?? "").trim();
    if (name) id = (await findUserByName(name)) ?? 0;
  }

  const nf = p.get("view") ? p.get("view") === "nf" : p.get("nf") === "1";
  let by = p.get("by") ?? "";
  if (!by && (p.get("level") || p.get("order"))) {
    const level = ((LEVELS as readonly string[]).includes(p.get("level") ?? "") ? p.get("level") : "sum") as Level;
    const order = ((ORDERS as readonly string[]).includes(p.get("order") ?? "") ? p.get("order") : "time") as Order;
    by = `${level}_${order}`;
  }
  const rankingBy = parseRankingBy(by);
  const { level, order } = byLevelOrder(rankingBy);

  // 手动拼相对 Location：nginx 反代下 req.url 是内部地址（localhost:3100），
  // NextResponse.redirect(absolute) 会把内网 host 泄给浏览器
  const qs = new URLSearchParams();
  if (nf) qs.set("view", "nf");
  if (rankingBy !== "sum_time") qs.set("by", rankingBy);

  if (id > 0) {
    const page = await getRankingPageOfUser(id, level, order, nf);
    if (page > 0) {
      // 底部按钮轻量探测：只回页码 JSON，不 302
      if (p.get("format") === "json") {
        return NextResponse.json({ page });
      }
      qs.set("page", String(page));
      const query = qs.toString();
      return new NextResponse(null, {
        status: 302,
        headers: { Location: `/ranking${query ? `?${query}` : ""}#id_${id}` },
      });
    }
    if (p.get("format") === "json") {
      return NextResponse.json({ page: page === -1 ? 0 : -1 });
    }
  }
  const query = qs.toString();
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/ranking${query ? `?${query}` : ""}` },
  });
}
