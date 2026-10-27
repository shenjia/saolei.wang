// 管理后台 · 玩家详情（2026-09-24）
// 资料 / 成绩 / 活跃度 / 最近录像 / 针对该玩家的后台操作记录，以及超管专属处置面板。

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { USER_ROLE } from "@/lib/config";
import { getUserDetailAdmin } from "@/lib/admin/data";
import { opLabel } from "@/lib/admin/log";
import { AdminAction, AdminForm } from "@/components/admin/AdminAction";
import { BanUserDialog } from "@/components/admin/BanUserDialog";
import { AdminCard, LevelTag, RoleTag, StatusTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { formatDate, score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { MESSAGE_CONTENT_LIMIT } from "@/lib/message";

export const dynamic = "force-dynamic";
export const metadata = { title: "玩家详情 | 管理后台" };


function rankBanCountdown(secLeft: number): string {
  const h = Math.floor(secLeft / 3600);
  const m = Math.floor((secLeft % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const uid = parseInt(id, 10);
  if (!uid) notFound();

  const [d, session] = await Promise.all([getUserDetailAdmin(uid), getSession()]);
  if (!d) notFound();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;
  const u = d.row;
  /* 2026-10-27 张老师实测：看自己的详情页也要能解除反作弊标记——处置面板本人也渲染，
     但隐藏自伤性操作（封禁/改管理员/注销），防自杀式误操作守卫收窄到操作级 */
  const isSelf = u.id === session?.uid;

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
          {u.trusted && (
            <span className="admin_tag ok" title="可信用户组：该玩家上传录像自动分拣时不检查 STNB 触发器">
              可信用户
            </span>
          )}
          {d.lowTrustFlagged && (
            <span className="admin_tag warn" title="反作弊探测命中：练习页排名模式禁用中，上传录像 24h ≤5 且全部需人工审核">
              低信任{d.rankBanned ? "·排名禁用" : ""}
            </span>
          )}
          {u.status === 0 ? (
            <span className="admin_tag ok">正常</span>
          ) : (
            <span className="admin_tag bad">
              已封禁{u.banUntil > 0 ? `·至 ${formatDate(u.banUntil, "Y-m-d H:i")}` : "·永久"}
            </span>
          )}
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
          <div className="label">称号</div>
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
          <div className="foot">最近 IP {d.lastLoginIp || "—"}</div>
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
            <dt>注册 IP</dt>
            <dd>
              {d.registerIp ? (
                <Link className="link" href={`/admin/ipgroups?dim=register&q=${encodeURIComponent(d.registerIp)}`}>
                  {d.registerIp}
                </Link>
              ) : (
                "—"
              )}
            </dd>
            <dt>最近登录</dt>
            <dd>{u.lastLoginTime ? formatDate(u.lastLoginTime, "Y-m-d H:i") : "从未登录"}</dd>
            <dt>第三方绑定</dt>
            <dd>
              {d.oauth.length
                ? d.oauth.map((o) => `${o.provider === "wechat" ? "微信" : "QQ"}（${o.nickname || "无昵称"}）`).join("、")
                : "—"}
            </dd>
            {d.rankedAudit && (
              <>
                <dt>
                  排名审计
                  {d.rankedAudit.suspicious && (
                    <span className="admin_tag bad" style={{ marginLeft: 6 }}>
                      异常
                    </span>
                  )}
                </dt>
                <dd>
                  {d.rankedAudit.games} 局 · 盲区点击率 {(d.rankedAudit.blindRate * 100).toFixed(1)}%
                  （{d.rankedAudit.blindClicks}/{d.rankedAudit.clicks}）· 旗精度 {(d.rankedAudit.flagPrecision * 100).toFixed(1)}%
                  （{d.rankedAudit.flags - d.rankedAudit.blindFlags}/{d.rankedAudit.flags}）
                  <span className="admin_hint" style={{ display: "block" }}>
                    盲区＝可靠性求解器无法证明安全的动作；求解器辅助玩家两项逼近 0%，正常玩家显著偏高（仅供人工分诊）
                  </span>
                </dd>
              </>
            )}
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
            <dt>爱好</dt>
            <dd>{d.interest || "—"}</dd>
          </dl>
        </AdminCard>
      </div>

      {/* ---------- 发送系统通知（manager 及以上）+ 账号处置（仅超管）----------
          2026-10-23 张老师要求：并排放置，通知在左、处置在右（ops_notify 栅格）；
          非超管视角无处置面板，通知卡单独一行（栅格单卡自动占满） */}
      <div className={`admin_grid${isSuper ? " ops_notify" : ""}`}>
        <AdminCard title="发送系统通知">
          <AdminForm
            op="user.sendSystemMessage"
            params={{ id: u.id }}
            layout="stack"
            fields={[
              {
                name: "content",
                label: `通知内容（最多 ${MESSAGE_CONTENT_LIMIT} 字，超出截断）`,
                type: "textarea",
                placeholder: `例如：你好，你上传的录像 #123 已通过审核，感谢分享。`,
                required: true,
              },
            ]}
            submitLabel="发送系统消息"
            confirm={`确认向「${u.chineseName}」发送这条系统消息？发送后立即进入对方收件箱，不可撤回。`}
          />
          <div className="admin_hint" style={{ marginTop: 8 }}>
            以「系统消息」身份发送（无寄件人），对方收件箱立即可见并计未读；管理员与超级管理员均可操作，操作记入日志。
          </div>
        </AdminCard>

        {/* ---------- 处置面板（仅超管；本人可见但隐藏自伤操作，2026-10-27） ---------- */}
        {isSuper && (
          <AdminCard
            title="账号处置"
            more={isSelf ? "本人视角：封禁/改管理员/注销等自伤操作已隐藏" : "仅超级管理员可见，全部操作记入日志"}
          >
            <div className="admin_ops" style={{ marginBottom: 14 }}>
              {!isSelf &&
                (u.status === 0 ? (
                  <BanUserDialog userId={u.id} name={u.chineseName} sm={false} />
                ) : (
                  <AdminAction
                    op="user.setStatus"
                    params={{ id: u.id, status: 0 }}
                    label="解除封禁"
                    variant="primary"
                    sm={false}
                    confirm={`确认解封「${u.chineseName}」？连坐封禁的录像将自动恢复。`}
                  />
                ))}
              {!isSelf && (
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
              )}
              <AdminAction
                op="user.setTrusted"
                params={{ id: u.id, trusted: u.trusted ? 0 : 1 }}
                label={u.trusted ? "移出可信用户组" : "加入可信用户组"}
                variant={u.trusted ? "warn" : "primary"}
                sm={false}
                confirm={
                  u.trusted
                    ? `确认把「${u.chineseName}」移出可信用户组？其后续上传录像将恢复 STNB 触发器检查，待审录像会立即重分拣。`
                    : `确认把「${u.chineseName}」加入可信用户组？其上传录像自动分拣时不再检查 STNB 触发器（其余触发器照常），待审录像会立即重分拣。`
                }
              />
              {/* 排名模式开关（2026-10-27 张老师定）：禁用中显示倒计时+解禁钮；
                  未禁用显示禁用钮。与信任组状态独立 */}
              {d.rankBanned ? (
                <>
                  <span className="admin_tag bad" style={{ alignSelf: "center" }}>
                    排名禁用中 · 剩余 {rankBanCountdown(d.rankBanUntil - Math.floor(Date.now() / 1000))}
                  </span>
                  <AdminAction
                    op="user.setRankBan"
                    params={{ id: u.id, on: 0 }}
                    label="解禁排名模式"
                    variant="primary"
                    sm={false}
                    confirm={`确认解禁「${u.chineseName}」的排名模式？其可立即恢复参与排名对局。`}
                  />
                </>
              ) : (
                <AdminAction
                  op="user.setRankBan"
                  params={{ id: u.id, on: 1 }}
                  label="禁用排名模式"
                  variant="warn"
                  sm={false}
                  confirm={`确认禁用「${u.chineseName}」的排名模式 24 小时？`}
                />
              )}
              {!u.trusted && !d.lowTrustFlagged && (
                <AdminAction
                  op="user.setLowTrust"
                  params={{ id: u.id }}
                  label="加入低信任用户组"
                  variant="warn"
                  sm={false}
                  confirm={`确认把「${u.chineseName}」加入低信任用户组？其 7 天内上传限流（每日 5 部）且全部录像需人工审核，练习页排名模式同步禁用 24 小时，待审录像会立即重分拣。`}
                />
              )}
              {d.lowTrustFlagged && (
                <AdminAction
                  op="user.clearCheatPenalty"
                  params={{ id: u.id }}
                  label="移出低信任用户组"
                  variant="warn"
                  sm={false}
                  confirm={`确认把「${u.chineseName}」移出低信任用户组？其练习页排名模式与上传限制立即恢复，待审录像会重分拣（解除后回免核定判定）。`}
                />
              )}
              {!isSelf &&
                (u.videos === 0 && d.postTotal === 0 ? (
                  <AdminAction
                    op="user.delete"
                    params={{ id: u.id }}
                    label="注销账号"
                    variant="danger"
                    sm={false}
                    confirm={`⚠️ 注销「${u.chineseName}」的登录凭据？该账号将永久无法登录（操作不可撤销）。`}
                  />
                ) : (
                  <span className="admin_hint" style={{ alignSelf: "center" }}>
                    该玩家已有 {u.videos} 部录像、{d.postTotal} 篇论坛主题，不能注销账号（如需禁止登录请用「封禁账号」）
                  </span>
                ))}
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
              重置结果（含新密码）会以气泡提示显示，请复制后转告玩家；同时会使所有未过期的找回密码链接失效。操作日志只留「已重置」事实，不记密码明文。
            </div>
          </AdminCard>
        )}
      </div>

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
