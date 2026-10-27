// 管理后台 · 可信用户组（2026-10-27 张老师需求）
// 组内玩家列表：加入时间 / 操作管理员（admin_log 反查），可移出（user.setTrusted）。
// 新成员行加亮（localStorage 对比），进入本页即清除侧栏 badge。

import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getTrustedGroup } from "@/lib/admin/usergroups";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { UserGroupTable } from "@/components/admin/UserGroupTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "可信用户组 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminTrustedPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const session = await getSession();
  const isAdmin = session?.role === USER_ROLE.ADMINISTRATOR;
  const { rows, total, pageSize, maxJoin } = await getTrustedGroup(page, sp.q);

  return (
    <>
      <div className="admin_page_head">
        <h1>可信用户组</h1>
        <span className="sub">共 {total} 名玩家 · 组内上传录像自动分拣不检查 STNB 触发器</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters fields={[{ name: "q", type: "search", placeholder: "玩家 ID / 姓名" }]} />
        </Suspense>
        <UserGroupTable groupKey="trusted" rows={rows} maxJoin={maxJoin} total={total} isAdmin={isAdmin} />
        <AdminPager base="/admin/trusted" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 可信用户组（user.trusted）：组内玩家上传录像自动分拣时不再检查 STNB 分位触发器，
          按住时长 / 手速 / 轨迹等其余触发器照常；加入或移出会立即重分拣其全部待审录像。<br />
          · 加入时间与操作管理员取自操作日志（user.setTrusted）；「早于 10-27」为建组前的历史成员，无法溯源。<br />
          · 移出仅超级管理员可执行，等价于玩家详情页的「移出可信用户组」。
        </div>
      </AdminCard>
    </>
  );
}
