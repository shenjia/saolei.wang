// 管理后台 · 旧「同 IP 账号组」独立入口（2026-11-13 并入玩家管理第四 tab ?group=ip）
// 旧地址只做重定向保兼容（书签 / 仪表盘 / 玩家详情页旧链接），查询参数原样带过去。

import { redirect } from "next/navigation";

type SP = Record<string, string | undefined>;

export default async function AdminIpGroupsRedirect({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const params = new URLSearchParams({ group: "ip" });
  for (const k of ["dim", "min", "only", "q", "page"] as const) {
    if (sp[k]) params.set(k, sp[k] as string);
  }
  redirect(`/admin/users?${params.toString()}`);
}
