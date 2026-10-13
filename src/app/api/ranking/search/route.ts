// 排行榜搜索框模糊推荐接口（2026-09-24 张老师要求，无按钮化改造配套）：
// GET /api/ranking/search?q=<关键字>&limit=8 → { users: [{id, chineseName, englishName, sex}] }
// 汉字前缀/包含模糊匹配（英文名前缀兜底），前端防抖 250ms 调用渲染下拉；
// 唯一候选时前端自动触发定位，无需点按钮。
// 2026-10-14（BV 榜搜索 C 方案）：带 bvBy=<total|beg|int|exp> 时额外回带 BV 名次
//   → { users: [{…, bvRank?}] }；缺 bvRank 即「未加入 BV 排行」。
//   数据取自 1 小时缓存的 BV 全量榜（内存 Map），不额外打库。

import { NextResponse } from "next/server";
import { searchUsers, getBvBoardIndex } from "@/lib/queries";
import { BV_RANKING_BYS, parseBvRankingBy } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = (p.get("q") ?? "").slice(0, 12);
  const limit = Math.min(12, Math.max(1, parseInt(p.get("limit") ?? "8", 10) || 8));
  const users = await searchUsers(q, limit);

  // BV 榜：附带名次（下拉「第 3,168 位」用）
  const bvRaw = p.get("bvBy") ?? "";
  if ((BV_RANKING_BYS as readonly string[]).includes(bvRaw)) {
    const { index } = await getBvBoardIndex(parseBvRankingBy(bvRaw));
    return NextResponse.json({
      users: users.map((u) => {
        const hit = index.get(u.id);
        return hit ? { ...u, bvRank: hit.rank } : u;
      }),
    });
  }

  return NextResponse.json({ users });
}
