// 排行榜搜索框模糊推荐接口（2026-09-24 张老师要求，无按钮化改造配套）：
// GET /api/ranking/search?q=<关键字>&limit=8 → { users: [{id, chineseName, englishName, sex}] }
// 汉字前缀/包含模糊匹配（英文名前缀兜底），前端防抖 250ms 调用渲染下拉；
// 唯一候选时前端自动触发定位，无需点按钮。
// 2026-10-14（BV 榜搜索 C 方案）：带 bvBy=<total|beg|int|exp> 时额外回带 BV 名次
//   → { users: [{…, bvRank?}] }；缺 bvRank 即「未加入 BV 排行」。
//   数据取自 1 小时缓存的 BV 全量榜（内存 Map），不额外打库。
// 2026-10-14（张老师要求：其他排行搜索也显示名次）：带 by=<RankingBy> 时回带成绩榜名次
//   → { users: [{…, rank?}] }（nf=1 走 user_scores_nf）；缺 rank 即「未加入排行」。
// 2026-10-20（STNB 榜）：带 bvBy + stnb=1 时回带 STNB 名次 → { users: [{…, stnbRank?}] }
//   （bvBy 参数名沿用——STNB 榜排序枚举与 BV 榜同构复用）。
// 2026-11-10（进步/活跃榜搜索，张老师要求：逻辑与体验与雷界榜一致）：
//   带 grow=1 → { users: [{…, growRank?}] }（rank_snapshot.delta>0 才在进步榜，快照口径）；
//   带 active=1 → { users: [{…, actRank?}] }（user_activity_snapshot 全列降序、
//   active_points>0 才在活跃榜，每分钟刷新快照口径）；与 by/bvBy 互斥。

import { NextResponse } from "next/server";
import { searchUsers, getBvBoardIndex, getStnbBoardIndex, getRankOfUsers } from "@/lib/queries";
import { getGrowRankOfUsers } from "@/lib/ranksnap";
import { getActiveRankOfUsers, ACTIVE_BYS, type ActiveBy } from "@/lib/activerank";
import { BV_RANKING_BYS, RANKING_BYS, parseBvRankingBy, type RankingBy } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = (p.get("q") ?? "").slice(0, 12);
  const limit = Math.min(12, Math.max(1, parseInt(p.get("limit") ?? "8", 10) || 8));
  const users = await searchUsers(q, limit);

  // BV / STNB 榜：附带名次（下拉「第 3,168 位」用）；stnb=1 区分两榜
  const bvRaw = p.get("bvBy") ?? "";
  const nf = p.get("nf") === "1";
  if ((BV_RANKING_BYS as readonly string[]).includes(bvRaw)) {
    if (p.get("stnb") === "1") {
      const { index } = await getStnbBoardIndex(parseBvRankingBy(bvRaw), nf);
      return NextResponse.json({
        users: users.map((u) => {
          const hit = index.get(u.id);
          return hit ? { ...u, stnbRank: hit } : u;
        }),
      });
    }
    const { index } = await getBvBoardIndex(parseBvRankingBy(bvRaw), nf);
    return NextResponse.json({
      users: users.map((u) => {
        const hit = index.get(u.id);
        return hit ? { ...u, bvRank: hit.rank } : u;
      }),
    });
  }

  // 成绩榜（雷界 / NF / 地区内页活跃值排序）：附带名次（下拉「第 N 位」用）
  // 2026-10-14 地区内页搜索：带 area 时名次限定该地区人口（缺失＝未加入地区排行）
  // 2026-11-10：by=act（活跃值）走 getRankOfUsers 内部 act 分支（快照表口径）
  const byRaw = p.get("by") ?? "";
  if ((RANKING_BYS as readonly string[]).includes(byRaw)) {
    const area = (p.get("area") ?? "").trim().slice(0, 12) || undefined;
    const ranks = await getRankOfUsers(
      users.map((u) => u.id),
      byRaw as RankingBy,
      p.get("nf") === "1",
      area
    );
    return NextResponse.json({
      users: users.map((u) => {
        const rank = ranks.get(u.id);
        return rank ? { ...u, rank } : u;
      }),
    });
  }

  // ---- 进步/活跃榜（2026-11-10）：同构回带榜内名次 ----
  // 进步榜：rank_snapshot 预计算 delta（30 天窗口口径），delta>0 即在榜；
  // 名次 = 榜内（delta>0 且今日有成绩）按 delta DESC、今日总计名次 ASC 的位次
  const growIds = users.map((u) => u.id);
  if (p.get("grow") === "1") {
    const ranks = await getGrowRankOfUsers(growIds);
    return NextResponse.json({
      users: users.map((u) => {
        const rank = ranks.get(u.id);
        return rank ? { ...u, growRank: rank } : u;
      }),
    });
  }
  // 活跃榜：user_activity_snapshot（每分钟刷新），名次与榜单表格完全一致
  //（当前排序列 DESC、user_id ASC；by 可选切列，默认 act=活跃指数）
  if (p.get("active") === "1") {
    const byRaw = p.get("by") ?? "";
    const by = (ACTIVE_BYS as readonly string[]).includes(byRaw) ? (byRaw as ActiveBy) : "act";
    const ranks = await getActiveRankOfUsers(growIds, by);
    return NextResponse.json({
      users: users.map((u) => {
        const rank = ranks.get(u.id);
        return rank ? { ...u, actRank: rank } : u;
      }),
    });
  }

  return NextResponse.json({ users });
}
