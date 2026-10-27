// 管理后台 · 反作弊复核（2026-10-27 张老师定：探测命中只禁排名，核实才转低信任）
// 待复核列表（resolved=0）+ 已复核历史。证据栈含 chrome-extension:// 前缀的
// 多为扩展误报（Grammarly/翻译类）——dismiss 即解除排名禁用。
// 核实（cheat.confirm）→ 转低信任 7 天 + 排名禁用 24h 重计；误报（cheat.dismiss）
// → 清除排名禁用。两操作都走站内浮窗确认。

import Link from "next/link";
import { prisma } from "@/lib/db";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminCard } from "@/components/admin/Widgets";

export const dynamic = "force-dynamic";
export const metadata = { title: "反作弊复核 | 管理后台" };

const REASON_LABEL: Record<string, string> = {
  op_bait: "诱饵读取",
  dom_inject: "DOM 注入",
  body_overlay: "覆盖层",
  canvas_tamper: "画布篡改",
  synthetic_input: "合成输入",
  proto_patch: "原型补丁",
  overlay_scan: "覆盖扫描",
  css_inject: "CSS 注入",
  shadow_dom: "Shadow 宿主",
  dom_foreign: "外来元素",
};

export default async function AdminCheatPage() {
  const [pending, resolved] = await Promise.all([
    prisma.cheatReport.findMany({
      where: { resolved: 0 },
      orderBy: { id: "desc" },
      take: 50,
    }),
    prisma.cheatReport.findMany({
      where: { resolved: { gt: 0 } },
      orderBy: { id: "desc" },
      take: 30,
    }),
  ]);

  const rows = (list: typeof pending) =>
    list.map((r) => {
      const extSuspect = r.evidence.includes("chrome-extension://");
      const userLink = (
        <Link href={`/admin/users/${r.user}`} target="_blank">
          #{r.user}
        </Link>
      );
      return (
        <tr key={r.id}>
          <td>{r.id}</td>
          <td>{userLink}</td>
          <td>{REASON_LABEL[r.reason] ?? r.reason}</td>
          <td className="cheat_ev" title={r.evidence}>
            {extSuspect ? "🧩 " : ""}
            {r.evidence.slice(0, 60)}
          </td>
          <td>{new Date(Number(r.createTime) * 1000).toLocaleString("zh-CN")}</td>
          {r.resolved === 0 ? (
            <td className="cheat_ops">
              <AdminAction
                op="cheat.confirm"
                params={{ reportId: Number(r.id) }}
                label="核实作弊"
                variant="danger"
                confirm={`确认核实报告 #${r.id} 为真实作弊？将转低信任用户组（7 天限流+全量人工审）并禁用排名模式 24 小时。`}
              />
              <AdminAction
                op="cheat.dismiss"
                params={{ reportId: Number(r.id) }}
                label="误报"
                variant="warn"
                confirm={`判定报告 #${r.id} 为误报？将立即解除该玩家的排名模式禁用。`}
              />
            </td>
          ) : (
            <td>{r.resolved === 1 ? "✅ 已核实（转低信任）" : "↩️ 误报（已解除）"}</td>
          )}
        </tr>
      );
    });

  return (
    <>
      <div className="admin_page_head">
        <h1>反作弊复核</h1>
      </div>
      <AdminCard title={`待复核（${pending.length}）`} tight>
        <table className="admin_table">
          <thead>
            <tr>
              <th>#</th>
              <th>玩家</th>
              <th>类型</th>
              <th>证据</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows(pending).length ? (
              rows(pending)
            ) : (
              <tr>
                <td colSpan={6} className="admin_hint">
                  暂无待复核报告——探测命中才会产生记录，干净时段为空属正常
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="admin_hint" style={{ marginTop: 8 }}>
          处置口径（2026-10-27 张老师定）：探测命中只禁用排名模式 24h；
          🧩 前缀（证据含 chrome-extension://）多为浏览器扩展误报——判「误报」立即解禁。
          核实为真实作弊才转低信任用户组（上传限 5/日 + 全量人工审 7 天）。
        </p>
      </AdminCard>
      {resolved.length > 0 && (
        <AdminCard title={`已复核（最近 ${resolved.length}）`} tight>
          <table className="admin_table">
            <thead>
              <tr>
                <th>#</th>
                <th>玩家</th>
                <th>类型</th>
                <th>证据</th>
                <th>时间</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>{rows(resolved)}</tbody>
          </table>
        </AdminCard>
      )}
    </>
  );
}
