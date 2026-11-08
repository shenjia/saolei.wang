// 地区榜（2026-11-08 URI 统一，张老师要求）：并入 /ranking?view=area，
// 渲染逻辑迁移至 components/AreaRankingView.tsx；旧路径 308 重定向
// （保留 name/by/page/hl/order 参数——地区内页与搜索定位落地链接仍在用）。

import { permanentRedirect } from "next/navigation";

export default async function AreaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ view: "area" });
  for (const key of ["name", "by", "page", "hl", "order"] as const) {
    if (sp[key]) qs.set(key, sp[key]!);
  }
  permanentRedirect(`/ranking?${qs.toString()}`);
}
