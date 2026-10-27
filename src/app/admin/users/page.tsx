// 管理后台 · 玩家管理（2026-09-24；2026-10-27 用户组 tab 聚合进来）
// 顶部三 tab（走 URL，同录像审核页签惯例）：全部玩家 / 可信用户组 / 低信任用户组——
// 两个组 tab 即原独立列表页原样搬入（组内成员、来源、加入时间、操作管理员、移出、新行加亮）；
// 「全部玩家」保持原玩家管理（搜索/筛选/排序，行内封禁·解封·改角色）。

import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getUserList, getAreaOptions } from "@/lib/admin/data";
import { getTrustedGroup, getLowTrustGroup, getGroupBadges } from "@/lib/admin/usergroups";
import { AdminAction, AdminSelect } from "@/components/admin/AdminAction";
import { BanUserDialog } from "@/components/admin/BanUserDialog";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager, RoleTag } from "@/components/admin/Widgets";
import { UserGroupTable } from "@/components/admin/UserGroupTable";
import { UserGroupTabs } from "@/components/admin/UserGroupTabs";
import { TitleBadge } from "@/components/Cells";
import { formatDate, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "玩家管理 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = await getSession();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;
  const tab = sp.group === "trusted" || sp.group === "lowtrust" ? sp.group : "all";

  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  // ---------- 顶部 tab（走 URL） ----------
  // tab 上挂各组自己的 badge（2026-10-27 张老师反馈：侧栏红点合并两组，
  // 落地页不知道该看哪个 tab）——信号与 layout 侧栏同源（getGroupBadges）
  const groupBadges = await getGroupBadges();

  // ---------- 组 tab：原独立列表页原样 ----------
  if (tab !== "all") {
    const { rows, total, pageSize, maxJoin } =
      tab === "trusted" ? await getTrustedGroup(page, sp.q) : await getLowTrustGroup(page, sp.q);
    return (
      <>
        <div className="admin_page_head">
          <h1>玩家管理</h1>
          <span className="sub">共 {total.toLocaleString("zh-CN")} 名玩家 · {tab === "trusted" ? "组内上传录像自动分拣不检查 STNB 触发器" : "反作弊标记 ∪ 屏蔽史（与录像分拣同口径），上传全量人工审核"}</span>
        </div>

        <AdminCard tight>
          <UserGroupTabs
            tab={tab}
            groupBadges={{
              trusted: { count: groupBadges.trustedCount, maxJoin: groupBadges.trustedMaxJoin },
              lowtrust: { count: groupBadges.lowTrustCount, maxJoin: groupBadges.lowTrustMaxJoin },
            }}
          />
          <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
            <AdminFilters fields={[{ name: "q", type: "search", placeholder: "玩家 ID / 姓名" }]} />
          </Suspense>
          <UserGroupTable groupKey={tab} rows={rows} maxJoin={maxJoin} total={total} isAdmin={isSuper} />
          <AdminPager
            base="/admin/users"
            params={{ group: tab, q: sp.q }}
            page={page}
            total={total}
            pageSize={pageSize}
          />
        </AdminCard>

        <AdminCard title="口径说明">
          <div className="admin_note">
            {tab === "trusted" ? (
              <>
                · 可信用户组（user.trusted）：组内玩家上传录像自动分拣时不再检查 STNB 分位触发器，
                按住时长 / 手速 / 轨迹等其余触发器照常；加入或移出会立即重分拣其全部待审录像。<br />
                · 加入时间与操作管理员取自操作日志（user.setTrusted）；「早于 10-27」为建组前的历史成员，无法溯源。<br />
                · 移出仅超级管理员可执行，等价于玩家详情页的「移出可信用户组」。
              </>
            ) : (
              <>
                · 低信任两源（与录像自动分拣同口径）：反作弊标记未到期（练习页探测命中或手动加入）、
                屏蔽史（名下有独立屏蔽的录像，且最近一次屏蔽晚于上次人工移出）——两者任一命中即入组。
                屏蔽录像时弹窗可选「是否将上传者加入低信任用户组」（默认加入，不加入则本次屏蔽不计入屏蔽史依据）。<br />
                · 组内每行都可「移出」（仅超管）：清反作弊标记 + 记人工移出时刻，屏蔽史据此豁免（旧录像不再算入组依据，
                之后再有录像被屏蔽且勾选「加入」会重新入组）；弹窗里可勾选「同时解除其名下被屏蔽录像的屏蔽」，
                把录像恢复为通过并让成绩回榜——不勾则录像保持屏蔽。<br />
                · 封禁账号不计入本组（不可能上传/打排名，状态看「账号状态」列或封禁列表）；解封后若仍有屏蔽史会自然回到组内。<br />
                · 加入时间与操作管理员：标记源取操作日志（探测器自动命中显示「反作弊系统」），屏蔽源取该录像的审核人与屏蔽时刻。
              </>
            )}
          </div>
        </AdminCard>
      </>
    );
  }

  // ---------- 全部玩家：原玩家管理原样 ----------
  const [{ rows, total, pageSize }, areas] = await Promise.all([
    getUserList({
      q: sp.q,
      status: sp.status,
      role: sp.role,
      sex: sp.sex,
      area: sp.area,
      ranked: sp.ranked,
      title: sp.title,
      order: sp.order,
      page,
    }),
    getAreaOptions(),
  ]);

  return (
    <>
      <div className="admin_page_head">
        <h1>玩家管理</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 名玩家命中当前条件</span>
      </div>

      <AdminCard tight>
        <UserGroupTabs
          tab={tab}
          groupBadges={{
            trusted: { count: groupBadges.trustedCount, maxJoin: groupBadges.trustedMaxJoin },
            lowtrust: { count: groupBadges.lowTrustCount, maxJoin: groupBadges.lowTrustMaxJoin },
          }}
        />
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "姓名 / 账号 / 昵称 / ID / 录像标识" },
              {
                name: "status",
                type: "select",
                prefix: "状态",
                options: [["", "全部状态"], ["normal", "正常"], ["banned", "已封禁"]],
              },
              {
                name: "role",
                type: "select",
                prefix: "角色",
                options: [
                  ["", "全部角色"],
                  ["100", "超级管理员"],
                  ["10", "管理员"],
                  ["0", "普通玩家"],
                ],
              },
              {
                name: "ranked",
                type: "select",
                prefix: "成绩",
                options: [["", "全部"], ["1", "已上榜"], ["0", "未上榜"]],
              },
              {
                name: "title",
                type: "select",
                prefix: "称号偏好",
                options: [["", "全部称号"], ["m", "军衔制"], ["c", "旧版人神界"]],
              },
              {
                name: "sex",
                type: "select",
                prefix: "性别",
                options: [["", "全部"], ["1", "男"], ["0", "女"]],
              },
              {
                name: "area",
                type: "select",
                prefix: "地区",
                options: [["", "全部地区"], ...areas.map((a) => [a, a] as [string, string])],
              },
              {
                name: "order",
                type: "select",
                prefix: "排序",
                options: [
                  ["reg", "注册时间（新→旧）"],
                  ["old", "注册时间（旧→新）"],
                  ["last", "最近登录"],
                  ["sum", "总计时间（快→慢）"],
                  ["name", "姓名"],
                ],
              },
            ]}
          />
        </Suspense>

        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>玩家</th>
                <th>账号</th>
                <th>地区</th>
                <th>称号</th>
                <th className="num">总计时间</th>
                <th className="num">录像</th>
                <th className="c">角色</th>
                <th className="c">状态</th>
                <th>注册</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={u.status !== 0 ? "off" : undefined}>
                  <td className="c sub">{u.id}</td>
                  <td>
                    <Link className="link" href={`/admin/users/${u.id}`}>
                      {u.chineseName}
                    </Link>
                    {u.englishName && <span className="sub"> {u.englishName}</span>}
                    {u.trusted && (
                      <span
                        className="admin_tag ok"
                        style={{ marginLeft: 6 }}
                        title="可信用户组：该玩家上传录像自动分拣时不检查 STNB 触发器"
                      >
                        可信
                      </span>
                    )}
                  </td>
                  <td className="sub">{u.username || "—"}</td>
                  <td className="sub">{u.area || "—"}</td>
                  <td>
                    <TitleBadge title={u.title} />
                  </td>
                  <td className="num">{u.sumTime ? scoreTime(u.sumTime) : "—"}</td>
                  <td className="num">{u.videos || "—"}</td>
                  <td className="c">
                    <RoleTag role={u.role} />
                  </td>
                  <td className="c">
                    {u.status === 0 ? (
                      <span className="admin_tag ok">正常</span>
                    ) : (
                      <span
                        className="admin_tag bad"
                        title={u.banUntil > 0 ? `至 ${formatDate(u.banUntil, "Y-m-d H:i")} 自动解禁` : "永久封禁"}
                      >
                        已封禁{u.banUntil > 0 ? `·至 ${formatDate(u.banUntil, "m-d H:i")}` : "·永久"}
                      </span>
                    )}
                  </td>
                  <td className="sub">{u.createTime ? timeOpposite(u.createTime, 0, "Y-m-d") : "—"}</td>
                  <td className="sub">{u.lastLoginTime ? timeOpposite(u.lastLoginTime, 0, "Y-m-d H:i") : "—"}</td>
                  <td className="ops">
                    <Link className="admin_btn sm" href={`/admin/users/${u.id}`}>
                      详情
                    </Link>
                    {isSuper && u.id !== session?.uid && (
                      <>
                        {u.status === 0 ? (
                          <BanUserDialog userId={u.id} name={u.chineseName} />
                        ) : (
                          <AdminAction
                            op="user.setStatus"
                            params={{ id: u.id, status: 0 }}
                            label="解封"
                            variant="primary"
                            confirm={`确认解封「${u.chineseName}」？连坐封禁的录像将自动恢复。`}
                          />
                        )}
                      </>
                    )}
                    {isSuper && u.id !== session?.uid && (
                      <AdminSelect
                        op="user.setRole"
                        params={{ id: u.id }}
                        name="role"
                        title="调整角色"
                        value={String(u.role)}
                        confirm={`确认修改「${u.chineseName}」的角色？管理员可审核录像与管理内容。`}
                        options={[
                          ["0", "玩家"],
                          ["10", "管理员"],
                          ["100", "超管"],
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12}>
                    <div className="admin_empty">没有符合条件的玩家</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/users" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="权限说明">
        <div className="admin_note">
          · <b>管理员（10）</b>可审核录像、处理评论 / 论坛 / 动态；<b>超级管理员（100）</b>额外可封禁玩家、改角色、重置密码、注销账号、群发站内信。<br />
          · 封禁依靠 <code>user.status</code>：0 = 正常、-1 = 封禁；登录接口会直接拒绝被封禁账号。封禁可选时长（一天/一周/一月/一年/永久），到期自动解禁；可选同步封禁该玩家录像，解禁时自动恢复。<br />
          · 注销账号（玩家详情页）只删除登录凭据（user_auth / oauth），保留成绩与录像，避免破坏排行榜与历史引用；仅对没有任何录像和论坛主题的玩家开放，有内容的玩家请改用封禁。<br />
          · <b>可信用户组</b>（玩家详情页设置，仅超管）：组内玩家上传录像自动分拣时不再检查 STNB 触发器（按住时长 / 手速 / 轨迹等其余触发器照常），加入或移出会立即重分拣其全部待审录像。<br />
          · 后台所有写操作都会记入<Link href="/admin/logs"> 操作日志 </Link>。
        </div>
      </AdminCard>
    </>
  );
}
