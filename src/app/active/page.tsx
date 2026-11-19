// 活跃排行（2026-11-08 URI 统一，张老师要求）：并入 /ranking?view=active，
// 渲染逻辑迁移至 components/ActiveRankingView.tsx；旧路径 308 重定向（保留 by/page 参数）。

import { permanentRedirect } from "next/navigation";

export default async function ActivePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ view: "active" });
  if (sp.by) qs.set("by", sp.by);
  if (sp.page) qs.set("page", sp.page);
  permanentRedirect(`/ranking?${qs.toString()}`);
}
