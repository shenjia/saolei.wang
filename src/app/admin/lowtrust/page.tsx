// 管理后台 · 低信任用户组（2026-10-27 张老师需求）
// 三源合并口径（与录像分拣 isLowTrustUser 一致）：反作弊标记未到期 / 封禁史 / 屏蔽史。
// 「反作弊标记」源可就地移出（user.clearCheatPenalty）；屏蔽史/封禁史是历史事实，
// 本页不提供移除（跳玩家详情页处理），与后台既有语义一致。

import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getLowTrustGroup } from "@/lib/admin/usergroups";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { UserGroupTable } from "@/components/admin/UserGroupTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "低信任用户组 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminLowTrustPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const session = await getSession();
  const isAdmin = session?.role === USER_ROLE.ADMINISTRATOR;
  const { rows, total, pageSize, maxJoin } = await getLowTrustGroup(page, sp.q);

  return (
    <>
      <div className="admin_page_head">
        <h1>低信任用户组</h1>
        <span className="sub">共 {total} 名玩家 · 上传录像全量人工审核（bit9 低信任触发器）</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters fields={[{ name: "q", type: "search", placeholder: "玩家 ID / 姓名" }]} />
        </Suspense>
        <UserGroupTable groupKey="lowtrust" rows={rows} maxJoin={maxJoin} total={total} isAdmin={isAdmin} />
        <AdminPager base="/admin/lowtrust" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 低信任三源（与录像自动分拣同口径）：反作弊标记未到期（练习页探测命中或手动加入）、
          封禁史（user.status=-1）、屏蔽史（名下有已屏蔽录像）——三者任一命中即入组。<br />
          · 「反作弊标记」源可就地移出（清排名禁用 + 低信任标记，待审录像立即重分拣）；
          封禁史 / 屏蔽史是既成事实，不属于可移除的标记，请到玩家详情页处理对应封禁 / 录像。<br />
          · 加入时间与操作管理员取自操作日志（加组 / 封禁 / 屏蔽动作）；探测器自动命中显示为「反作弊系统」。
        </div>
      </AdminCard>
    </>
  );
}
