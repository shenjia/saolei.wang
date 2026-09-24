// 管理后台 · 玩家详情（2026-09-24）
// 资料 / 成绩 / 活跃度 / 最近录像 / 针对该玩家的后台操作记录，以及超管专属处置面板。

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getUserDetailAdmin } from "@/lib/admin/data";
import { opLabel } from "@/lib/admin/log";
import { AdminAction, AdminForm } from "@/components/admin/AdminAction";
import { AdminCard, LevelTag, RoleTag, StatusTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { formatDate, score3bvs, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "玩家详情 | 管理后台" };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const uid = parseInt(id, 10);
  if (!uid) notFound();

  const [d, session] = await Promise.all([getUserDetailAdmin(uid), getSession()]);
  if (!d) notFound();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;
  const u = d.row;

  return (
    <>
      <div className="admin_page_head">
        <h1>
          {u.chineseName}
          <span className="sub" style={{ marginLeft: 8 }}>
            #{u.id} · {u.username || "无账号"}
          </span>
        </h1>
        <div className="right">
          <RoleTag role={u.role} />
          {u.status === 0 ? <span className="admin_tag ok">正常</span> : <span className="admin_tag bad">已封禁</span>}
          <Link className="admin_btn" href={`/user/${u.id}`} target="_blank">
            前台主页
          </Link>
          <Link className="admin_btn" href="/admin/users">
            返回列表
          </Link>
        </div>
      </div>

      <div className="admin_kpis">
        <div className="admin_kpi green">
          <div className="label">军衔</div>
          <div className="value" style={{ fontSize: 20 }}>
            <TitleBadge title={u.title} />
          </div>
          <div className="foot">总计时间 {u.sumTime ? scoreTime(u.sumTime) + " 秒" : "无"}</div>
        </div>
        <div className="admin_kpi yellow">
          <div className="label">总计时间名次</div>
          <div className="value">{d.sumRank || "—"}</div>
          <div className="foot">上榜玩家中的位置</div>
        </div>
        <div className="admin_kpi cyan">
          <div className="label">录像数</div>
          <div className="value">{u.videos}</div>
          <div className="foot">
            初 {d.ranks.beg || "—"} / 中 {d.ranks.int || "—"} / 高 {d.ranks.exp || "—"} 名
          </div>
        </div>
        <div className="admin_kpi purple">
          <div className="label">动态 / 评论 / 主题</div>
          <div className="value" style={{ fontSize: 20 }}>
            {d.newsCount} / {d.commentCount} / {d.bbsCount}
          </div>
          <div className="foot">收件箱 {d.messageCount} 条</div>
        </div>
        <div className="admin_kpi orange">
          <div className="label">地盘人气</div>
          <div className="value">{d.clicks}</div>
          <div className="foot">去重 IP / 天</div>
        </div>
        <div className="admin_kpi grey">
          <div className="label">登录次数</div>
          <div className="value">{d.loginTimes}</div>
          <div className="foot">最近 IP {d.loginIp || "—"}</div>
        </div>
      </div>

      <div className="admin_grid c2">
        <AdminCard title="账号信息">
          <dl className="admin_kv">
            <dt>ID</dt>
            <dd>{u.id}</dd>
            <dt>账号</dt>
            <dd>{u.username || "—（已注销）"}</dd>
            <dt>昵称</dt>
            <dd>{d.nickname || "—"}</dd>
            <dt>性别</dt>
            <dd>{u.sex ? "男" : "女"}</dd>
            <dt>地区</dt>
            <dd>{u.area || "—"}</dd>
            <dt>注册时间</dt>
            <dd>{u.createTime ? formatDate(u.createTime, "Y-m-d H:i") : "—"}</dd>
            <dt>最近登录</dt>
            <dd>{u.lastLoginTime ? formatDate(u.lastLoginTime, "Y-m-d H:i") : "从未登录"}</dd>
            <dt>第三方绑定</dt>
            <dd>
              {d.oauth.length
                ? d.oauth.map((o) => `${o.provider === "wechat" ? "微信" : "QQ"}（${o.nickname || "无昵称"}）`).join("、")
                : "—"}
            </dd>
          </dl>
        </AdminCard>

        <AdminCard title="个人资料">
          <dl className="admin_kv">
            <dt>QQ</dt>
            <dd>{d.qq || "—"}</dd>
            <dt>鼠标</dt>
            <dd>{d.mouse || "—"}</dd>
            <dt>鼠标垫</dt>
            <dd>{d.pad || "—"}</dd>
            <dt>自我介绍</dt>
            <dd>{d.selfIntro || "—"}</dd>
            <dt>兴趣爱好</dt>
            <dd>{d.interest || "—"}</dd>
          </dl>
        </AdminCard>
      </div>

      {/* ---------- 处置面板（仅超管） ---------- */}
      {isSuper && u.id !== session?.uid && (
        <AdminCard title="账号处置" more="仅超级管理员可见，全部操作记入日志">
          <div className="admin_ops" style={{ marginBottom: 14 }}>
            {u.status === 0 ? (
              <AdminAction
                op="user.setStatus"
                params={{ id: u.id, status: -1 }}
                label="封禁账号"
                variant="danger"
                sm={false}
                confirm={`确认封禁「${u.chineseName}」？封禁后该账号无法登录，已有成绩保留。`}
              />
            ) : (
              <AdminAction
                op="user.setStatus"
                params={{ id: u.id, status: 0 }}
                label="解除封禁"
                variant="primary"
                sm={false}
                confirm={`确认解封「${u.chineseName}」？`}
              />
            )}
            <AdminAction
              op="user.setRole"
              params={{ id: u.id, role: u.role === USER_ROLE.PLAYER ? USER_ROLE.MANAGER : USER_ROLE.PLAYER }}
              label={u.role === USER_ROLE.PLAYER ? "设为管理员" : "取消管理员"}
              variant="warn"
              sm={false}
              confirm={
                u.role === USER_ROLE.PLAYER
                  ? `确认把「${u.chineseName}」设为管理员？管理员可审核录像并管理内容。`
                  : `确认取消「${u.chineseName}」的管理权限？`
              }
            />
            <AdminAction
              op="user.delete"
              params={{ id: u.id }}
              label="注销账号"
              variant="danger"
              sm={false}
              confirm={`⚠️ 注销「${u.chineseName}」的登录凭据？该账号将永久无法登录（成绩与录像保留，操作不可撤销）。`}
            />
          </div>

          <AdminForm
            op="user.resetPassword"
            params={{ id: u.id }}
            layout="row"
            fields={[
              {
                name: "password",
                label: "重置密码",
                placeholder: "留空则随机生成 10 位",
                width: "search",
              },
            ]}
            submitLabel="执行重置"
            confirm="确认重置该玩家密码？旧密码立即失效。"
          />
          <div className="admin_hint" style={{ marginTop: 8 }}>
            重置结果（含新密码）会以气泡提示显示，请复制后转告玩家；同时会使所有未过期的找回密码链接失效。
          </div>
        </AdminCard>
      )}

      {/* ---------- 最近录像 ---------- */}
      <AdminCard title="最近录像" tight more={<Link href={`/admin/videos?q=${u.id}`}>该玩家全部录像 →</Link>}>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th className="c">级别</th>
                <th className="num">时间</th>
                <th className="num">3BV/s</th>
                <th className="num">3BV</th>
                <th className="c">状态</th>
                <th>上传时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {d.recentVideos.map((v) => (
                <tr key={v.id}>
                  <td className="c">
                    <Link className="link" href={`/video/${v.id}`} target="_blank">
                      {v.id}
                    </Link>
                  </td>
                  <td className="c">
                    <LevelTag level={v.level} />
                  </td>
                  <td className="num strong">{v.realTime ? scoreTime(v.realTime) : "—"}</td>
                  <td className="num">{v.board3bv ? score3bvs(Math.round((v.board3bv * 1e6) / v.realTime)) : "—"}</td>
                  <td className="num">{v.board3bv || "—"}</td>
                  <td className="c">
                    <StatusTag status={v.status} />
                  </td>
                  <td className="sub">{v.createTime ? timeOpposite(v.createTime) : "—"}</td>
                  <td className="ops">
                    <Link className="admin_btn sm" href={`/admin/videos?q=${v.id}`}>
                      管理
                    </Link>
                  </td>
                </tr>
              ))}
              {d.recentVideos.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="admin_empty">该玩家还没有上传录像</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="针对该账号的后台操作记录" tight more={<Link href="/admin/logs">全部日志 →</Link>}>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {d.recentLogs.map((l, i) => (
                <tr key={i}>
                  <td className="sub">{formatDate(l.createTime, "Y-m-d H:i")}</td>
                  <td>
                    <span className="admin_tag plain">{opLabel(l.action)}</span>
                  </td>
                  <td>{l.detail}</td>
                </tr>
              ))}
              {d.recentLogs.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <div className="admin_empty">暂无操作记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </>
  );
}
