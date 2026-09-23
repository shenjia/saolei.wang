// 排行榜搜索框模糊推荐接口（2026-09-24 张老师要求，无按钮化改造配套）：
// GET /api/ranking/search?q=<关键字>&limit=8 → { users: [{id, chineseName, englishName, sex}] }
// 汉字前缀/包含模糊匹配（英文名前缀兜底），前端防抖 250ms 调用渲染下拉；
// 唯一候选时前端自动触发定位，无需点按钮。

import { NextResponse } from "next/server";
import { searchUsers } from "@/lib/queries";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = (p.get("q") ?? "").slice(0, 12);
  const limit = Math.min(12, Math.max(1, parseInt(p.get("limit") ?? "8", 10) || 8));
  const users = await searchUsers(q, limit);
  return NextResponse.json({ users });
}
