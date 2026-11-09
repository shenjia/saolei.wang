// 公开 API · 排行榜查询（2026-11-09 张老师需求）
// GET /api/public/v1/ranking?view=<视图>&order=<排序列>&cursor=<页码游标>[&size=N]
// 鉴权：X-Api-Key（lib/partner.ts），限速按 key 各自配置。
//
// 覆盖线上排行页除「世界排行」（world，聚合站外数据）外的全部榜单，与站内
// 「加载更多」同一查询函数/同一排序口径：
//   · view=rank   成绩榜（雷界）：order=beg_time|beg_3bvs|int_time|int_3bvs|exp_time|exp_3bvs|sum_time|sum_3bvs，可选 nf=1 走 NF 榜、area=地区名限定人口
//   · view=bv     BV 收集榜：order=total|beg|int|exp，可选 nf=1
//   · view=stnb   STNB 榜：order=total|beg|int|exp，可选 nf=1
//   · view=area   地区榜：order=activity|power|players|active|best（地区维度，非玩家）
// 分页：cursor = 上次响应的 nextCursor（整数页码，首次不传 = 第 1 页），每页默认 20 条、
// size 可放大本批行数（上限 100，页锚点恒按 20——站内「加载更多」递增批量同款语义）。
// hasMore = 已取末位名次 < total；越界 cursor 返回空 rows、hasMore=false。
// 每行附 title（军衔，2026-11-06 动态阈值总司令口径）；隐私字段（IP/邮箱/登录时间）不出。
// 聚合榜（bv/stnb）数据源失败时返回 503（与站内 more 路由降级行为一致）。

import { NextResponse } from "next/server";
import { requirePartnerEx, unauthorized, rateLimited, partnerRateLimit } from "@/lib/partner";
import {
  getRankingTable,
  getBvRanking,
  getStnbRanking,
  getAreaRanking,
} from "@/lib/queries";
import { parseRankingBy, parseBvRankingBy, parseAreaOrder, areaDisplay, AREA_LIST } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingThreshold } from "@/lib/title-system";

export async function GET(req: Request) {
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  if (!partnerRateLimit(partner, "pub-ranking")) return rateLimited(partner.ratePerMin);

  const p = new URL(req.url).searchParams;
  const view = p.get("view") ?? "rank";
  const cursorRaw = parseInt(p.get("cursor") ?? "1", 10);
  const page = Math.max(1, Number.isFinite(cursorRaw) ? cursorRaw : 1);
  const sizeRaw = parseInt(p.get("size") ?? "", 10);
  const size = Math.min(Math.max(sizeRaw || 20, 20), 100);
  const nf = p.get("nf") === "1";

  // 军衔称号预算（各视图共用；2026-11-06 总司令=动态阈值档）
  const kingTh = await getThunderKingThreshold();

  // ---------- 成绩榜（雷界 / NF / 地区内页） ----------
  if (view === "rank") {
    const by = parseRankingBy(p.get("order") ?? "");
    const area = p.get("area")?.trim() || undefined;
    if (area && !(AREA_LIST as readonly string[]).includes(area)) {
      return NextResponse.json({ error: "bad_request", message: "无效的 area 参数" }, { status: 400 });
    }
    const { rows, total } = await getRankingTable(by, nf, page, area, sizeRaw ? size : undefined);
    // 总计时间榜附今日升降（站内榜单同款；ensureTodaySnapshot 幂等）
    let deltas: [number, number | null][] | undefined;
    if (by === "sum_time" && !nf && !area) {
      const { ensureTodaySnapshot, getSumTimeDeltas } = await import("@/lib/ranksnap");
      await ensureTodaySnapshot();
      const map = await getSumTimeDeltas(rows.map((r) => r.id));
      deltas = rows.map((r) => [r.id, map.get(r.id) ?? null] as [number, number | null]);
    }
    const pairs = await dualTitles(
      rows.map((u) => ({ userId: Number(u.id), expTime: u.overallExpTime ?? u.scores.exp_time, ranked: true, sex: u.sex }))
    );
    return NextResponse.json({
      view,
      order: by,
      nf,
      ...(area ? { area: areaDisplay(area) } : {}),
      cursor: page,
      nextCursor: page * 20 < total ? page + 1 : null,
      hasMore: page * 20 < total,
      total,
      size: rows.length,
      generatedAt: Math.floor(Date.now() / 1000),
      // scores/videos 为 8 列（beg_time…sum_3bvs，时间=ms、3bvs=×1000，0=无成绩）；
      // delta 仅总计时间主榜提供：数字=较昨日升降名次，null=无昨日基准（今日新进榜）
      rows: rows.map((u, i) => ({
        rank: u.rank,
        id: u.id,
        name: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        title: assessTitle(u.overallExpTime ?? u.scores.exp_time, kingTh),
        scores: u.scores,
        videos: u.videos,
        delta: deltas?.find(([id]) => id === u.id)?.[1] ?? null,
        classic: pairs[i]?.c ?? null,
      })),
    });
  }

  // ---------- BV 收集榜 ----------
  if (view === "bv") {
    const by = parseBvRankingBy(p.get("order") ?? "");
    let data;
    try {
      data = await getBvRanking(by, page, sizeRaw ? size : undefined, nf);
    } catch (e) {
      console.error("[api/public/v1/ranking] BV 榜数据获取失败", e);
      return NextResponse.json({ error: "bv_unavailable", message: "BV 榜数据暂不可用，请稍后重试" }, { status: 503 });
    }
    const { rows, total } = data;
    const pairs = await dualTitles(rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex })));
    return NextResponse.json({
      view,
      order: by,
      nf,
      cursor: page,
      nextCursor: page * 20 < total ? page + 1 : null,
      hasMore: page * 20 < total,
      total,
      size: rows.length,
      generatedAt: Math.floor(Date.now() / 1000),
      // beg/int/exp=各级收集数，total=三者之和；den（各级 3BV 可达区间跨度）与
      // totalDen 进度分母随响应带出，消费方算百分比可直接用
      den: data.den,
      totalDen: data.totalDen,
      rows: rows.map((u, i) => ({
        rank: u.rank,
        id: u.id,
        name: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        title: assessTitle(u.expTime, kingTh),
        beg: u.beg,
        int: u.int,
        exp: u.exp,
        total: u.total,
        classic: pairs[i]?.c ?? null,
      })),
    });
  }

  // ---------- STNB 榜 ----------
  if (view === "stnb") {
    const by = parseBvRankingBy(p.get("order") ?? "");
    let data;
    try {
      data = await getStnbRanking(by, page, sizeRaw ? size : undefined, nf);
    } catch (e) {
      console.error("[api/public/v1/ranking] STNB 榜数据获取失败", e);
      return NextResponse.json({ error: "stnb_unavailable", message: "STNB 榜数据暂不可用，请稍后重试" }, { status: 503 });
    }
    const { rows, total } = data;
    const pairs = await dualTitles(rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex })));
    return NextResponse.json({
      view,
      order: by,
      nf,
      cursor: page,
      nextCursor: page * 20 < total ? page + 1 : null,
      hasMore: page * 20 < total,
      total,
      size: rows.length,
      generatedAt: Math.floor(Date.now() / 1000),
      // beg/int/exp=各级历史最高 STNB（1 位小数；0=该级无有效成绩），total 仅三级齐全时非 0；
      // den（各级全站最高 STNB）与 totalDen 进度分母随响应带出
      den: data.den,
      totalDen: data.totalDen,
      rows: rows.map((u, i) => ({
        rank: u.rank,
        id: u.id,
        name: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        title: assessTitle(u.expTime, kingTh),
        beg: u.beg,
        int: u.int,
        exp: u.exp,
        total: u.total,
        // best.<level> = 该级最优盘 { vid, timeMs, nf, ct }（null=无），vid 可链 /video/{id}
        best: u.best,
        classic: pairs[i]?.c ?? null,
      })),
    });
  }

  // ---------- 地区榜 ----------
  if (view === "area") {
    const order = parseAreaOrder(p.get("order") ?? "");
    const all = await getAreaRanking(order);
    const start = (page - 1) * 20;
    const slice = all.slice(start, start + size);
    return NextResponse.json({
      view,
      order,
      cursor: page,
      nextCursor: page * 20 < all.length ? page + 1 : null,
      hasMore: page * 20 < all.length,
      total: all.length,
      size: slice.length,
      generatedAt: Math.floor(Date.now() / 1000),
      rows: slice.map((r, i) => ({
        rank: start + i + 1,
        area: areaDisplay(r.area),
        players: Number(r.players),
        active: Number(r.active),
        power: Number(r.power),
        activity: Number(r.activity),
        bestRank: Number(r.bestRank),
        wins7d: Number(r.wins7d),
        videos7d: Number(r.videos7d),
        best: {
          id: Number(r.bestId),
          name: r.bestName,
          englishName: r.bestEnglishName,
          expTime: Number(r.bestExpTime),
          sumTime: Number(r.bestSumTime),
        },
      })),
    });
  }

  return NextResponse.json(
    { error: "bad_request", message: "无效的 view 参数（rank / bv / stnb / area）" },
    { status: 400 }
  );
}
