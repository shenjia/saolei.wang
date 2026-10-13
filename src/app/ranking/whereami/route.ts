// 「我在哪里」查找定位（移植 2008 版 Ranking/Goto：按姓名或 ID 定位到对应页锚点）
// GET /ranking/whereami?id=<uid>&name=<姓名>&q=<姓名或ID>&view=all|nf&by=<排序列>
//   &format=json → { page }（底部「我在哪里」按钮轻量探测页码用）
// → 302 到 /ranking?...&page=N#id_<uid>；兼容旧参数 level/order/nf/name/id
// 2026-09-24：新增合并搜索框参数 q（纯数字按 ID、否则按姓名），原 name/id 仍可用
// 2026-10-14：新增 view=bv（BV 收集榜）——该榜人口＝有已通过录像（≠成绩榜人口），
//   名次走 1 小时缓存的全量数组 getBvRankOfUser（零 DB），落地 URL 与成绩榜同构（page+hl）
// 2026-10-14：新增 area=<地区>（地区内页搜索定位）——页码限定该地区人口，302 回 /area（page+hl）

import { NextRequest, NextResponse } from "next/server";
import { findUserByName, getRankingPageOfUser, getBvRankOfUser } from "@/lib/queries";
import {
  byLevelOrder,
  parseRankingBy,
  parseBvRankingBy,
  LEVELS,
  ORDERS,
  type Level,
  type Order,
} from "@/lib/config";

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

  // ---- BV 收集榜分支（2026-10-14）：名次不进成绩表体系，改走缓存数组 ----
  // 榜外（没传过录像 / 无已通过录像）→ json 回 page:0（前端弹气泡），302 则退回榜首
  if (p.get("view") === "bv") {
    const bvBy = parseBvRankingBy(p.get("by") ?? "");
    const bqs = new URLSearchParams({ view: "bv" });
    if (bvBy !== "total") bqs.set("by", bvBy);
    if (id > 0) {
      const hit = await getBvRankOfUser(id, bvBy);
      if (hit) {
        if (p.get("format") === "json") return NextResponse.json({ page: hit.page });
        bqs.set("page", String(hit.page));
        bqs.set("hl", String(id)); // 定位落地行持续高亮（与成绩榜同款）
        return new NextResponse(null, {
          status: 302,
          headers: { Location: `/ranking?${bqs.toString()}#id_${id}` },
        });
      }
      if (p.get("format") === "json") return NextResponse.json({ page: 0 });
    }
    return new NextResponse(null, {
      status: 302,
      headers: { Location: `/ranking?${bqs.toString()}` },
    });
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

  // ---- 地区内页分支（2026-10-14 张老师要求：地区排行也支持搜索）----
  // 页码/名次限定该地区人口（getRankingPageOfUser 的 area 参数）；地区内页只有雷界口径（无 NF）
  const area = (p.get("area") ?? "").trim().slice(0, 12);
  if (area) {
    const aqs = new URLSearchParams({ name: area });
    if (rankingBy !== "sum_time") aqs.set("by", rankingBy);
    if (id > 0) {
      const page = await getRankingPageOfUser(id, level, order, false, area);
      if (page > 0) {
        if (p.get("format") === "json") return NextResponse.json({ page });
        aqs.set("page", String(page));
        aqs.set("hl", String(id)); // 定位落地行持续高亮（与成绩榜同款）
        return new NextResponse(null, {
          status: 302,
          headers: { Location: `/area?${aqs.toString()}#id_${id}` },
        });
      }
      if (p.get("format") === "json") return NextResponse.json({ page: 0 });
    }
    return new NextResponse(null, {
      status: 302,
      headers: { Location: `/area?${aqs.toString()}` },
    });
  }

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
      qs.set("hl", String(id)); // 定位落地行持续高亮（2026-09-24 张老师要求）
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
