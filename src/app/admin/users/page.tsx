// 管理后台 · 玩家管理（2026-09-24）
// 列表：搜索 / 状态 / 角色 / 性别 / 地区 / 是否有成绩 / 排序，行内可直接封禁·解封·改角色。

import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getUserList, getAreaOptions } from "@/lib/admin/data";
import { AdminAction, AdminSelect } from "@/components/admin/AdminAction";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager, RoleTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "玩家管理 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = await getSession();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;

  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const [{ rows, total, pageSize }, areas] = await Promise.all([
    getUserList({
      q: sp.q,
      status: sp.status,
      role: sp.role,
      sex: sp.sex,
      area: sp.area,
      ranked: sp.ranked,
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
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "姓名 / 账号 / 昵称 / ID" },
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
                <th>军衔</th>
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
                      <span className="admin_tag bad">已封禁</span>
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
                          <AdminAction
                            op="user.setStatus"
                            params={{ id: u.id, status: -1 }}
                            label="封禁"
                            variant="danger"
                            confirm={`确认封禁「${u.chineseName}」？封禁后无法登录。`}
                          />
                        ) : (
                          <AdminAction
                            op="user.setStatus"
                            params={{ id: u.id, status: 0 }}
                            label="解封"
                            variant="primary"
                            confirm={`确认解封「${u.chineseName}」？`}
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
          · 封禁依靠 <code>user.status</code>：0 = 正常、-1 = 封禁；登录接口会直接拒绝被封禁账号。<br />
          · 注销账号（玩家详情页）只删除登录凭据（user_auth / oauth），保留成绩与录像，避免破坏排行榜与历史引用。<br />
          · 后台所有写操作都会记入<Link href="/admin/logs"> 操作日志 </Link>。
        </div>
      </AdminCard>
    </>
  );
}
