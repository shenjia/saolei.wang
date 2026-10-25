// 管理后台 · 公开 API key 管理（2026-10-24）
// 对外 API（/api/public/v1/*）的调用凭据：签发/吊销/恢复。
// key 只存 sha256 哈希——明文仅在签发成功的 toast 里出现一次，关闭即不可再查
//（操作日志里留档签发记录，与「重置密码回显」同款先例，后台是超管可见面）。

import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { AdminCard } from "@/components/admin/Widgets";
import { AdminAction } from "@/components/admin/AdminAction";
import { ApiKeyCreateForm } from "@/components/admin/ApiKeyCreateForm";
import { TrendChart, SERIES_COLORS, type Series } from "@/components/admin/Charts";
import { dayStart } from "@/lib/admin/stats";
import { formatDate } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "API Key 管理 | 管理后台" };

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 今日调用走势（2026-10-25）：api_key_usage 小时桶（+08:00，口径同 stats.ts，不依赖时区） */
async function todayUsage(keys: { id: bigint; name: string }[]): Promise<{
  labels: string[];
  series: Series[];
  total: number;
}> {
  const today0 = dayStart(0);
  const hourBase = Math.floor((today0 + 28800) / 3600);
  const rows = await prisma.$queryRaw<Array<{ h: bigint; k: bigint; c: bigint }>>`
    SELECT hour - ${hourBase} AS h, \`key\` AS k, CAST(calls AS SIGNED) AS c
    FROM api_key_usage WHERE hour >= ${hourBase}
  `;
  const now = Math.floor(Date.now() / 1000);
  const curHour = Math.floor((now + 28800) / 3600) - hourBase;
  const nHours = Math.min(24, curHour + 1);
  const labels = Array.from({ length: nHours }, (_, i) => `${i}时`);

  const nameOf = new Map<number, string>([[0, "草案 key（env）"]]);
  for (const k of keys) nameOf.set(Number(k.id), k.name);

  const byKey = new Map<number, number[]>();
  for (const r of rows) {
    const h = N(r.h);
    if (h < 0 || h >= nHours) continue;
    const kid = N(r.k);
    const arr = byKey.get(kid) ?? new Array<number>(nHours).fill(0);
    arr[h] += N(r.c);
    byKey.set(kid, arr);
  }

  const series = [...byKey.entries()]
    .map(([kid, values]) => ({
      key: String(kid),
      label: nameOf.get(kid) ?? `key #${kid}`,
      values,
      sum: values.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.sum - a.sum)
    .map((s, i) => ({
      key: s.key,
      label: s.label,
      values: s.values,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));

  return {
    labels,
    series,
    total: rows.reduce((a, r) => a + N(r.c), 0),
  };
}

export default async function AdminApiKeysPage() {
  await requireAdmin("administrator");
  const keys = await prisma.apiKey.findMany({ orderBy: { id: "desc" } });
  const usage = await todayUsage(keys.map((k) => ({ id: k.id, name: k.name })));

  return (
    <>
      <div className="admin_page_head">
        <h1>API Key 管理</h1>
        <span className="sub">对外公开 API（/api/public/v1/*）调用凭据的签发与吊销</span>
      </div>

      <AdminCard title="签发新 key">
        <ApiKeyCreateForm />
      </AdminCard>

      <AdminCard title={`今日调用走势（${usage.total.toLocaleString("zh-CN")} 次）`} more={<span className="sub">0 时起 · 累计到当前小时 · 点击图例下方合作方名看分接口统计 · <Link href="/admin/apikeys/0">草案 key（env）</Link></span>}>
        {usage.labels.length > 1 ? (
          <TrendChart dates={usage.labels} series={usage.series} unit=" 次" rawLabel height={200} legendHrefBase="/admin/apikeys" />
        ) : (
          <div className="admin_empty">今日暂无调用</div>
        )}
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
                <td>
                  <Link href={`/admin/apikeys/${Number(k.id)}`}>{k.name}</Link>
                </td>
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
          <li>历史 .env 里的 PARTNER_API_KEYS 草案 key 在过渡期仍可用（查库优先），建议尽快迁到本表管理；草案 key 的调用以「草案 key（env）」计入走势图。</li>
          <li>走势图数据来自 2026-10-25 新增的分时用量表（api_key_usage，按小时累加），此前的历史调用无分时记录。</li>
        </ul>
      </AdminCard>
    </>
  );
}
