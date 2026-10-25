// 管理后台 · API key 合作方调用详情（2026-10-25）
// 从 /admin/apikeys 列表（合作方名/走势图图例 ↗）进入：
// · 该 key 今日分时走势（复用 TrendChart，接口合并口径，与列表页一致）
// · 分接口调用统计（今日 / 总计两列，含占比；endpoint 空=早期无接口维度数据）
// id=0 是伪详情：env 草案 key 的聚合行（无 api_key 表实体，页面按特殊分支渲染）。

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { TrendChart, type Series } from "@/components/admin/Charts";
import { dayStart } from "@/lib/admin/stats";
import { formatDate } from "@/lib/format";
import { AdminAction } from "@/components/admin/AdminAction";

export const dynamic = "force-dynamic";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

const ENDPOINT_NAMES: Record<string, string> = {
  stats: "站点统计",
  video_list: "录像列表",
  video_info: "录像详情",
  user_list: "玩家列表",
  user_info: "玩家详情",
};

export default async function ApiKeyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin("administrator");
  const { id } = await params;
  const keyId = parseInt(id, 10);
  if (Number.isNaN(keyId) || keyId < 0) notFound();

  // key=0：env 草案 key 伪详情（不查 api_key 表）；其余查实体，无此行 404
  const draft = {
    id: BigInt(0),
    name: "草案 key（env）",
    status: 1,
    note: ".env PARTNER_API_KEYS 过渡期草案 key 聚合",
    requestCount: BigInt(0),
    lastUsedAt: BigInt(0),
    createTime: BigInt(0),
  };
  const row = keyId === 0 ? draft : await prisma.apiKey.findUnique({ where: { id: BigInt(keyId) } });
  if (!row) notFound();

  const today0 = dayStart(0);
  const hourBase = Math.floor((today0 + 28800) / 3600);

  // 全量行（小时×接口），今日/总计都从这一份内存聚合（单 key 量级：60次/分上限 → 全年 ~3 万行，可接受）
  const rows = await prisma.$queryRaw<Array<{ hour: bigint; endpoint: string; calls: bigint }>>`
    SELECT hour, endpoint, CAST(calls AS SIGNED) AS calls
    FROM api_key_usage WHERE \`key\` = ${keyId}
  `;

  // ---- 今日走势（接口合并，按小时）----
  const now = Math.floor(Date.now() / 1000);
  const curHour = Math.floor((now + 28800) / 3600) - hourBase;
  const nHours = Math.min(24, Math.max(1, curHour + 1));
  const labels = Array.from({ length: nHours }, (_, i) => `${i}时`);
  const hourAgg = new Array<number>(nHours).fill(0);
  // ---- 分接口统计（今日 / 总计）----
  const byEpToday = new Map<string, number>();
  const byEpAll = new Map<string, number>();
  for (const r of rows) {
    const calls = N(r.calls);
    const ep = r.endpoint || "";
    byEpAll.set(ep, (byEpAll.get(ep) ?? 0) + calls);
    const h = N(r.hour) - hourBase;
    if (h >= 0 && h < nHours) {
      byEpToday.set(ep, (byEpToday.get(ep) ?? 0) + calls);
      hourAgg[h] += calls;
    }
  }
  const todayTotal = hourAgg.reduce((a, b) => a + b, 0);
  const allTotal = [...byEpAll.values()].reduce((a, b) => a + b, 0);

  const series: Series[] = [
    { key: "calls", label: row.name, values: hourAgg, color: "#a6e22e" },
  ];

  const eps = [...byEpAll.entries()]
    .map(([ep, all]) => ({ ep, all, today: byEpToday.get(ep) ?? 0 }))
    .sort((a, b) => b.all - a.all);

  return (
    <>
      <div className="admin_page_head">
        <h1>
          {row.name}
          <span className="sub" style={{ marginLeft: 8 }}>
            {keyId === 0 ? "env 草案 key" : `#${keyId}`} · {row.status === 1 ? "启用" : "已吊销"}
          </span>
        </h1>
        <div className="right">
          <Link href="/admin/apikeys" className="sub">
            ← 返回 key 管理
          </Link>
        </div>
      </div>

      <div className="admin_kpis">
        <Kpi label="今日调用" value={todayTotal} unit="次" tone="green" />
        <Kpi label="累计调用（分时表）" value={allTotal} unit="次" tone="cyan" />
        {keyId !== 0 && (
          <>
            <Kpi label="api_key 累计调用" value={N(row.requestCount)} unit="次" tone="grey" foot="含 2026-10-25 前无分时记录的历史" />
            <Kpi
              label="最近使用"
              value={N(row.lastUsedAt) > 0 ? formatDate(N(row.lastUsedAt), "Y-m-d H:i") : "—"}
              tone="yellow"
            />
          </>
        )}
      </div>

      <AdminCard title={`今日调用走势（${todayTotal.toLocaleString("zh-CN")} 次）`} more={<span className="sub">0 时起 · 累计到当前小时</span>}>
        {labels.length > 1 ? (
          <TrendChart dates={labels} series={series} unit=" 次" rawLabel height={200} />
        ) : (
          <div className="admin_empty">今日暂无调用</div>
        )}
      </AdminCard>

      <AdminCard title={`分接口调用统计（总计 ${allTotal.toLocaleString("zh-CN")} 次）`} tight>
        {eps.length ? (
          <table className="admin_table">
            <thead>
              <tr>
                <th>接口</th>
                <th>今日</th>
                <th>今日占比</th>
                <th>总计</th>
                <th>总计占比</th>
              </tr>
            </thead>
            <tbody>
              {eps.map((e) => (
                <tr key={e.ep || "_unknown"}>
                  <td>
                    {e.ep ? (
                      <>
                        <code>{e.ep}</code>
                        <span className="sub" style={{ marginLeft: 8 }}>
                          {ENDPOINT_NAMES[e.ep] ?? ""}
                        </span>
                      </>
                    ) : (
                      <span className="sub">（早期数据 · 未分接口）</span>
                    )}
                  </td>
                  <td>{e.today.toLocaleString("zh-CN")}</td>
                  <td className="sub">{todayTotal ? `${((e.today / todayTotal) * 100).toFixed(1)}%` : "—"}</td>
                  <td>{e.all.toLocaleString("zh-CN")}</td>
                  <td className="sub">{allTotal ? `${((e.all / allTotal) * 100).toFixed(1)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="admin_empty">暂无调用记录</div>
        )}
      </AdminCard>

      {keyId !== 0 && (
        <AdminCard title="key 信息">
          <table className="admin_table">
            <tbody>
              <tr>
                <td className="sub" style={{ width: 140 }}>签发时间</td>
                <td>{formatDate(N(row.createTime), "Y-m-d H:i")}</td>
              </tr>
              <tr>
                <td className="sub">备注</td>
                <td>{row.note || "—"}</td>
              </tr>
              <tr>
                <td className="sub">状态操作</td>
                <td>
                  {row.status === 1 ? (
                    <AdminAction
                      op="apikey.revoke"
                      params={{ id: keyId }}
                      label="吊销"
                      variant="danger"
                      confirm={`确定吊销「${row.name}」的 key 吗？\n\n吊销后对方所有 API 调用立即（最迟 30 秒）返回 401。`}
                    />
                  ) : (
                    <AdminAction op="apikey.restore" params={{ id: keyId }} label="恢复" />
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </AdminCard>
      )}
    </>
  );
}
