// 强制绑定页：老用户账密登录后未绑定微信/QQ 时落地到这里
// 扫码后走回调分支 1（已登录 → 绑定到当前账号）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import BindForm from "./BindForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "绑定账号 - 扫雷网" };

export default async function BindPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const bindCount = await prisma.userOauth.count({ where: { userId: BigInt(session.uid) } });
  if (bindCount > 0) redirect("/");

  const sp = await searchParams;
  return (
    <div id="page" className="main">
      <BindForm error={sp.error ?? ""} />
    </div>
  );
}
