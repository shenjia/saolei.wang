// 批量玩家活跃度查询（2026-11-05 全站气泡第二行）：
// GET /api/user/activity?ids=1,2,3 → { "1": {"act":4,"tip":"7天内登录过"}, ... }
// 供 ActLine 客户端组件按页合并批量调用；数据口径与排行榜标记同源（lib/activity），
// 非敏感信息（排行榜页本就公开展示活跃度）。
import { activityInfo } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, 300); // 单页人名数量级 ~几十，300 上限防滥用
  if (!ids.length) return Response.json({});
  const info = await activityInfo(ids);
  const out: Record<string, { act: number; tip: string }> = {};
  for (const [id, v] of info) out[String(id)] = { act: v.act, tip: v.tip };
  return Response.json(out);
}
