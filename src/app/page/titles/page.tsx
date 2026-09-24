// 军衔体系页已迁移至 /titles（原 /world，2026-09-24 改名）
// 此路由保留 302：全站 TitleBadge 徽章链接指向 /page/titles

import { redirect } from "next/navigation";

export default function TitlesPage() {
  redirect("/titles");
}
