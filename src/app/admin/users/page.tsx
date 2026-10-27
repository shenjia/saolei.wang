// 管理后台 · 玩家管理（2026-09-24；2026-10-27 用户组合并进来）
// 列表：搜索 / 状态 / 角色 / 性别 / 地区 / 是否有成绩 / 用户组（全部·可信·低可信）/ 排序，
// 行内可直接封禁·解封·改角色；用户组视图追加「来源 / 加入时间 / 操作管理员 / 标记到期」列 + 移出按钮，
// 新成员行加亮并清除导航 badge。

import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getUserList, getAreaOptions } from "@/lib/admin/data";
import { getGroupBadges } from "@/lib/admin/usergroups";
import { AdminAction, AdminSelect } from "@/components/admin/AdminAction";
import { BanUserDialog } from "@/components/admin/BanUserDialog";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager, RoleTag } from "@/components/admin/Widgets";
import { GroupSeenMark, GroupRowHighlight, GroupRemoveBtn } from "@/components/admin/UserGroupCells";
import { TitleBadge } from "@/components/Cells";
import { formatDate, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "玩家管理 | 管理后台" };

type SP = Record<string, string | undefined>;

const GROUP_VIEWS = {
  trusted: { label: "可信用户组", sub: "组内上传录像自动分拣不检查 STNB 触发器" },
  lowtrust: { label: "低可信用户组", sub: "反作弊标记 ∪ 封禁史 ∪ 屏蔽史（与录像分拣同口径），上传全量人工审核" },
} as const;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = await getSession();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;
  const group = sp.group === "trusted" || sp.group === "lowtrust" ? sp.group : null;

  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const [{ rows, total, pageSize }, areas, badges] = await Promise.all([
    getUserList({
      q: sp.q,
      status: sp.status,
      role: sp.role,
      sex: sp.sex,
      area: sp.area,
      ranked: sp.ranked,
      title: sp.title,
      group: sp.group,
      order: sp.order,
      page,
    }),
    getAreaOptions(),
    // 组视图才查 badge（供已读基线：组内最新加入时刻 + 组人数，全组口径）
    group ? getGroupBadges() : Promise.resolve(null),
  ]);
  const groupMaxJoin = badges ? (group === "trusted" ? badges.trustedMaxJoin : badges.lowTrustMaxJoin) : 0;
  const groupTotal = badges ? (group === "trusted" ? badges.trustedCount : badges.lowTrustCount) : 0;

  return (
    <>
      <div className="admin_page_head">
        <h1>玩家管理{group ? ` · ${GROUP_VIEWS[group].label}` : ""}</h1>
        <span className="sub">
          共 {total.toLocaleString("zh-CN")} 名玩家{group ? ` · ${GROUP_VIEWS[group].sub}` : "命中当前条件"}
        </span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "姓名 / 账号 / 昵称 / ID / 录像标识" },
              {
                name: "group",
                type: "select",
                prefix: "用户组",
                options: [["", "全部用户"], ["trusted", "可信用户组"], ["lowtrust", "低可信用户组"]],
              },
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
              ...(group
                ? [] // 组视图固定「最新加入在前」（无 SQL 排序依据），排序控件隐藏
                : [
                    {
                      name: "order",
                      type: "select" as const,
                      prefix: "排序",
                      options: [
                        ["reg", "注册时间（新→旧）"],
                        ["old", "注册时间（旧→新）"],
                        ["last", "最近登录"],
                        ["sum", "总计时间（快→慢）"],
                        ["name", "姓名"],
                      ] as [string, string][],
                    },
                  ]),
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
                {group === "lowtrust" && <th>来源</th>}
                {group && <th>加入时间</th>}
                {group && <th>操作管理员</th>}
                {group === "lowtrust" && <th>标记到期</th>}
                <th className="c">角色</th>
                <th className="c">状态</th>
                <th>注册</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const body = (
                  <>
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
                    {group === "lowtrust" && (
                      <td>
                        {(u.groupInfo?.sources ?? []).map((s) => (
                          <span
                            key={s}
                            className={`admin_tag ${s === "反作弊标记" ? "bad" : s === "封禁史" ? "warn" : "plain"}`}
                            style={{ marginRight: 4 }}
                          >
                            {s}
                          </span>
                        ))}
                      </td>
                    )}
                    {group && (
                      <td className="sub">
                        {u.groupInfo?.joinTime ? (
                          formatDate(u.groupInfo.joinTime, "Y-m-d H:i")
                        ) : (
                          <span title="建组前的历史记录，无法溯源">早于 10-27</span>
                        )}
                      </td>
                    )}
                    {group && <td className="sub">{u.groupInfo?.joinBy ?? "—"}</td>}
                    {group === "lowtrust" && (
                      <td className="sub">
                        {u.groupInfo && u.groupInfo.flagUntil > 0
                          ? formatDate(u.groupInfo.flagUntil, "Y-m-d H:i")
                          : "—"}
                      </td>
                    )}
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
                      {group && isSuper && (
                        <>
                          {group === "trusted" ? (
                            <GroupRemoveBtn id={u.id} name={u.chineseName} mode="trusted" />
                          ) : u.groupInfo?.sources.includes("反作弊标记") ? (
                            <GroupRemoveBtn id={u.id} name={u.chineseName} mode="flag" />
                          ) : (
                            <Link className="admin_btn sm" href={`/admin/users/${u.id}`}>
                              详情处理
                            </Link>
                          )}
                        </>
                      )}
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
                  </>
                );
                return group ? (
                  <GroupRowHighlight key={u.id} group={group} joinTime={u.groupInfo?.joinTime ?? null}>
                    {body}
                  </GroupRowHighlight>
                ) : (
                  <tr key={u.id} className={u.status !== 0 ? "off" : undefined}>
                    {body}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={group === "lowtrust" ? 15 : group ? 13 : 12}>
                    <div className="admin_empty">没有符合条件的玩家</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/users" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      {group && <GroupSeenMark group={group} maxJoin={groupMaxJoin} total={groupTotal} />}

      <AdminCard title="权限说明">
        <div className="admin_note">
          · <b>管理员（10）</b>可审核录像、处理评论 / 论坛 / 动态；<b>超级管理员（100）</b>额外可封禁玩家、改角色、重置密码、注销账号、群发站内信。<br />
          · 封禁依靠 <code>user.status</code>：0 = 正常、-1 = 封禁；登录接口会直接拒绝被封禁账号。封禁可选时长（一天/一周/一月/一年/永久），到期自动解禁；可选同步封禁该玩家录像，解禁时自动恢复。<br />
          · 注销账号（玩家详情页）只删除登录凭据（user_auth / oauth），保留成绩与录像，避免破坏排行榜与历史引用；仅对没有任何录像和论坛主题的玩家开放，有内容的玩家请改用封禁。<br />
          · <b>可信用户组</b>（仅超管）：组内玩家上传录像自动分拣时不再检查 STNB 触发器（按住时长 / 手速 / 轨迹等其余触发器照常），加入或移出会立即重分拣其全部待审录像。<br />
          · <b>低可信用户组</b>：反作弊标记未到期 / 封禁史 / 屏蔽史任一命中即入组，上传录像全量人工审核；「反作弊标记」源可就地移出，封禁史 / 屏蔽史请到玩家详情页处理对应的封禁 / 录像。<br />
          · 后台所有写操作都会记入<Link href="/admin/logs"> 操作日志 </Link>。
        </div>
      </AdminCard>
    </>
  );
}
