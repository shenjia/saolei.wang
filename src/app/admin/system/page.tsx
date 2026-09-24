// 管理后台 · 系统信息（2026-09-24）
// 环境自检（上线前必配项）+ 运行时信息 + 数据库表规模。

import Link from "next/link";
import { getEnvChecks, getRuntimeInfo, getTableStats } from "@/lib/admin/system";
import { getSnapshotHealth } from "@/lib/admin/stats";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";
import { OAUTH_ENABLED } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "系统信息 | 管理后台" };

function humanSeconds(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${sec % 60} 秒`;
}

export default async function AdminSystemPage() {
  const [envs, runtime, tables, snapshot] = await Promise.all([
    Promise.resolve(getEnvChecks()),
    getRuntimeInfo(),
    getTableStats(),
    getSnapshotHealth(),
  ]);

  const missing = envs.filter((e) => !e.ok);

  return (
    <>
      <div className="admin_page_head">
        <h1>系统信息</h1>
        <span className="sub">环境自检与数据库规模，上线前请逐项确认</span>
      </div>

      <div className="admin_kpis">
        <Kpi
          label="环境自检"
          value={missing.length === 0 ? "全部就绪" : `${missing.length} 项待配置`}
          tone={missing.length === 0 ? "green" : "red"}
          foot={missing.length ? missing.map((m) => m.label).join("、") : "所有关键配置齐全"}
        />
        <Kpi label="数据库版本" value={runtime.dbVersion} tone="cyan" foot={`环境 ${runtime.env}`} />
        <Kpi label="Node" value={runtime.nodeVersion} tone="grey" foot={`Next ${runtime.nextVersion} · Prisma ${runtime.prismaVersion}`} />
        <Kpi label="进程内存" value={runtime.memoryMb} unit="MB" tone="purple" foot={`已运行 ${humanSeconds(runtime.uptimeSeconds)}`} />
        <Kpi
          label="今日排行快照"
          value={snapshot.todayDone ? "已生成" : "未生成"}
          tone={snapshot.todayDone ? "green" : "red"}
          foot={`累计 ${snapshot.days} 天`}
        />
      </div>

      {/* ---------- 环境自检 ---------- */}
      <AdminCard title="环境配置自检" tight>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">状态</th>
                <th>配置项</th>
                <th>环境变量</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {envs.map((e) => (
                <tr key={e.key} className={e.ok ? undefined : "off"}>
                  <td className="c">
                    {e.ok ? <span className="admin_tag ok">已配置</span> : <span className="admin_tag bad">缺失</span>}
                  </td>
                  <td>{e.label}</td>
                  <td className="mono">{e.key}</td>
                  <td className="sub">{e.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {missing.length > 0 && (
        <AdminCard title="待办：补齐缺失配置">
          <div className="admin_note">
            未配置的项会影响对应功能，但不影响站点启动：<br />
            · <b>邮件相关（SMTP_*）</b>：配好后「忘记密码」才能真正发出重置邮件；当前未配置时重置链接只打在服务端日志里。<br />
            · <b>SITE_URL</b>：用于拼接重置密码链接的域名前缀，建议设置为 <code>https://saolei.wang</code>。<br />
            · 配置方式：在项目 <code>.env</code> 或部署环境里追加变量后重启服务。
          </div>
        </AdminCard>
      )}

      {/* ---------- 运行时 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="运行时">
          <dl className="admin_kv">
            <dt>环境</dt>
            <dd>{runtime.env}</dd>
            <dt>Node</dt>
            <dd>{runtime.nodeVersion}</dd>
            <dt>Next.js</dt>
            <dd>{runtime.nextVersion}</dd>
            <dt>Prisma</dt>
            <dd>{runtime.prismaVersion}</dd>
            <dt>MySQL</dt>
            <dd>{runtime.dbVersion}</dd>
            <dt>服务器时区</dt>
            <dd>{runtime.timezone}</dd>
            <dt>服务器时间</dt>
            <dd>{formatDate(runtime.serverTime, "Y-m-d H:i:s")}</dd>
            <dt>进程内存</dt>
            <dd>{runtime.memoryMb} MB（RSS）</dd>
            <dt>已运行</dt>
            <dd>{humanSeconds(runtime.uptimeSeconds)}</dd>
          </dl>
        </AdminCard>

        <AdminCard title="功能开关与约定">
          <dl className="admin_kv">
            <dt>第三方登录</dt>
            <dd>
              {OAUTH_ENABLED ? (
                <span className="admin_tag ok">已开启</span>
              ) : (
                <span className="admin_tag plain">本地测试期关闭</span>
              )}
              <div className="sub" style={{ marginTop: 4 }}>
                微信 / QQ 扫码在 <code>src/lib/config.ts</code> 的 <code>OAUTH_ENABLED</code> 控制，
                两平台申请落地后置为 true 即恢复。
              </div>
            </dd>
            <dt>录像状态</dt>
            <dd>
              <span className="admin_tag wait">10 待审</span> <span className="admin_tag ok">20 通过</span>{" "}
              <span className="admin_tag bad">0 屏蔽</span>
            </dd>
            <dt>玩家状态</dt>
            <dd>
              <span className="admin_tag ok">0 正常</span> <span className="admin_tag bad">-1 封禁</span>
            </dd>
            <dt>日志表</dt>
            <dd>
              <code>admin_log</code>（只增不改）· <Link href="/admin/logs">查看日志</Link>
            </dd>
          </dl>
        </AdminCard>
      </div>

      {/* ---------- 表规模 ---------- */}
      <AdminCard title="数据库表规模" tight more={`共 ${tables.total.toLocaleString("zh-CN")} 行（information_schema 估算值，可能与精确值略有偏差）`}>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>数据表</th>
                <th>用途</th>
                <th className="num">行数</th>
                <th className="num">占比</th>
              </tr>
            </thead>
            <tbody>
              {tables.tables.map((t) => (
                <tr key={t.table}>
                  <td className="mono">{t.table}</td>
                  <td>{t.label}</td>
                  <td className="num strong">{t.rows.toLocaleString("zh-CN")}</td>
                  <td className="num sub">
                    {tables.total ? ((t.rows / tables.total) * 100).toFixed(1) : "0.0"}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="运维速查">
        <div className="admin_note">
          · 开发预览：<code>https://dev.saolei.wang</code>（launchd <code>com.saolei.dev</code> 常驻，
          重启：<code>launchctl kickstart -k gui/$(id -u)/com.saolei.dev</code>）。<br />
          · 样式：主站 2013 视觉走 <code>public/styles/legacy-2013.css</code>（以 <code>&lt;link&gt;</code> 原样加载），
          后台专属样式在 <code>src/app/admin/admin.css</code>。<br />
          · 旧站数据同步管线在 <code>scripts/sync/</code>（extract → transform → fixup → validate），
          凭据一律走环境变量，不入库。<br />
          · 后台入口仅对管理员（role ≥ 10）可见，普通玩家访问会直接跳回首页。
        </div>
      </AdminCard>
    </>
  );
}
