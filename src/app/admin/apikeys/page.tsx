// 管理后台 · 公开 API key 管理（2026-10-24）
// 对外 API（/api/public/v1/*）的调用凭据：签发/吊销/恢复。
// key 只存 sha256 哈希——明文仅在签发成功的 toast 里出现一次，关闭即不可再查
//（操作日志里留档签发记录，与「重置密码回显」同款先例，后台是超管可见面）。

import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { AdminCard } from "@/components/admin/Widgets";
import { AdminAction, AdminForm } from "@/components/admin/AdminAction";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "API Key 管理 | 管理后台" };

export default async function AdminApiKeysPage() {
  await requireAdmin("administrator");
  const keys = await prisma.apiKey.findMany({ orderBy: { id: "desc" } });

  return (
    <>
      <div className="admin_page_head">
        <h1>API Key 管理</h1>
        <span className="sub">对外公开 API（/api/public/v1/*）调用凭据的签发与吊销</span>
      </div>

      <AdminCard title="签发新 key">
        <AdminForm
          op="apikey.create"
          layout="stack"
          submitLabel="签发"
          fields={[
            { name: "name", label: "合作方名称", placeholder: "如 openms.top", required: true, hint: "限速与用量统计的维度" },
            { name: "note", label: "备注", placeholder: "用途 / 联系方式（可选）" },
          ]}
        />
        <p className="admin_hint" style={{ marginTop: 8 }}>
          明文 key 仅在签发成功的提示里显示一次，请当场复制发给合作方；库里只存哈希，后台无法再查明文。
        </p>
      </AdminCard>

      <AdminCard title={`已签发 key（${keys.length}）`} tight>
        <table className="admin_table">
          <thead>
            <tr>
              <th>#</th>
              <th>合作方</th>
              <th>状态</th>
              <th>调用次数</th>
              <th>最近使用</th>
              <th>签发时间</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={String(k.id)}>
                <td className="sub">#{Number(k.id)}</td>
                <td>{k.name}</td>
                <td>
                  {k.status === 1 ? <span className="admin_tag ok">启用</span> : <span className="admin_tag bad">已吊销</span>}
                </td>
                <td>{Number(k.requestCount).toLocaleString("zh-CN")}</td>
                <td className="sub">
                  {Number(k.lastUsedAt) > 0 ? formatDate(Number(k.lastUsedAt), "Y-m-d H:i") : "—"}
                </td>
                <td className="sub">{formatDate(Number(k.createTime), "Y-m-d H:i")}</td>
                <td className="sub" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {k.note || "—"}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {k.status === 1 ? (
                    <AdminAction
                      op="apikey.revoke"
                      params={{ id: Number(k.id) }}
                      label="吊销"
                      variant="danger"
                      confirm={`确定吊销「${k.name}」的 key 吗？\n\n吊销后对方所有 API 调用立即（最迟 30 秒）返回 401。`}
                    />
                  ) : (
                    <AdminAction op="apikey.restore" params={{ id: Number(k.id) }} label="恢复" />
                  )}
                </td>
              </tr>
            ))}
            {!keys.length && (
              <tr>
                <td colSpan={8} className="sub" style={{ textAlign: "center", padding: 24 }}>
                  尚未签发任何 key
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </AdminCard>

      <AdminCard title="口径说明">
        <ul className="admin_tips">
          <li>接口清单与字段文档见 <code>docs/partner-api-openms.md</code>；接口基础路径 <code>/api/public/v1/</code>。</li>
          <li>限速 60 次/分钟/合作方（进程内滑动窗口）；nginx 侧另有全站兜底限速。</li>
          <li>吊销为软删（保留审计轨迹），可随时恢复；明文不可找回，丢失只能重新签发。</li>
          <li>历史 .env 里的 PARTNER_API_KEYS 草案 key 在过渡期仍可用（查库优先），建议尽快迁到本表管理。</li>
        </ul>
      </AdminCard>
    </>
  );
}
