// 管理后台 · 录像审核（2026-09-24 建，原名「审核管理」，2026-10-27 张老师更名——该页只审录像）
// 待审队列 + 批量审核 + 审核积压监控；审核状态变更统一走 lib/review.ts。

import Link from "next/link";
import { getVideoListAdmin, getPoolCounts } from "@/lib/admin/data";
import { getAuditorWorkload, getOverview } from "@/lib/admin/stats";
import { usersByIds } from "@/lib/queries";
import { VIDEO_STATUS } from "@/lib/config";
import { AdminReviewList } from "@/components/admin/AdminReviewList";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { BarList } from "@/components/admin/Charts";
import { timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像审核 | 管理后台" };

type SP = Record<string, string | undefined>;

const TABS: [string, string][] = [
  [String(VIDEO_STATUS.NORMAL), "待审核"],
  [String(VIDEO_STATUS.REVIEWED), "已通过"],
  [String(VIDEO_STATUS.BANNED), "已屏蔽"],
];

/** 待审核页内的分拣池页签（2026-10-19 自动分拣）：机器只分拣，通过永远管理员手动 */
const POOLS: [string, string][] = [
  ["exempt", "免核定（可一键过）"],
  ["need", "需核定（只能手审）"],
];

export default async function AdminReviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const status = ["10", "20", "0"].includes(sp.status ?? "") ? parseInt(sp.status!, 10) : VIDEO_STATUS.NORMAL;
  // 默认落点（2026-10-21 张老师需求）：不带 pool 进待审视图时，有免核定录像
  // → 默认进免核定（可一键过）；一条都没有 → 默认进需核定（手审）。手动切过的 URL 带参不受影响。
  const rawPool = sp.pool;
  let pool = ["exempt", "need"].includes(rawPool ?? "") ? rawPool : undefined;
  let poolCounts: { exempt: number; need: number } = { exempt: 0, need: 0 };
  if (status === VIDEO_STATUS.NORMAL) {
    poolCounts = await getPoolCounts();
    if (!pool) pool = poolCounts.exempt > 0 ? "exempt" : "need";
  }
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  // 2026-11-10 张老师定：审核队列一律按「上传时间」倒序，最新在最前，三个状态页签同口径。
  // 原口径是待审用 old（id 升序清积压）、已审用 new（id 降序），都是 id 序；
  // 历史同步/补导录像的 id 与上传时间不一致，按 id 排会让「上传时间」列看着乱序。
  const [list, ov, workload, workload7] = await Promise.all([
    getVideoListAdmin({ status: String(status), order: "upload", page, pool }),
    getOverview(),
    getAuditorWorkload(6),
    getAuditorWorkload(10, 7),
  ]);
  const auditors = await usersByIds([...new Set([...workload, ...workload7].map((w) => w.user))]);

  const pendingDays = ov.oldestPendingDays;

  return (
    <div className="admin_review_page">
      <div className="admin_page_head">
        <h1>录像审核</h1>
        <span className="sub">
          待审 {ov.videoPending} 条
          {ov.oldestPendingTime > 0 && ` · 最老一条上传于 ${timeOpposite(ov.oldestPendingTime, 0, "Y-m-d H:i")}（${pendingDays} 天前）`}
        </span>
      </div>

      <div className="admin_kpis">
        <Kpi label="待审核" value={ov.videoPending} tone={ov.videoPending > 0 ? "red" : "green"} foot={ov.videoPending ? `积压最久 ${pendingDays} 天` : "队列已清空"} />
        <Kpi label="已通过" value={ov.videoReviewed} tone="green" foot={`占全部录像 ${ov.passRate}%`} />
        <Kpi label="已屏蔽" value={ov.videoBanned} tone="grey" foot="含历史封禁" />
        <Kpi
          label="平均审核耗时"
          value={ov.avgAuditSeconds ? Math.round(ov.avgAuditSeconds / 60) : "—"}
          unit={ov.avgAuditSeconds ? "分钟" : undefined}
          tone="cyan"
          foot="上传 → 出审核结果"
        />
        <Kpi label="今日上传" value={ov.videoToday} tone="yellow" foot="全部状态" />
      </div>

      <AdminCard tight className="review_queue">
        {/* 状态页签：走 URL，便于分享与退回 */}
        <div className="admin_filterbar">
          {TABS.map(([v, label]) => (
            <Link
              key={v}
              href={`/admin/review?status=${v}`}
              className={`admin_btn${String(status) === v ? " primary" : ""}`}
            >
              {label}
            </Link>
          ))}
          <span className="spacer" />
          <span className="label">共 {list.total.toLocaleString("zh-CN")} 条</span>
        </div>

        {/* 分拣池页签（仅待审核页显示）：免核定可批量一键过，需核定只能逐条手审 */}
        {status === VIDEO_STATUS.NORMAL && (
          <div className="admin_filterbar" style={{ borderTop: 0 }}>
            {POOLS.map(([v, label]) => (
              <Link
                key={v}
                href={`/admin/review?status=10&pool=${v}`}
                className={`admin_btn${pool === v ? (v === "exempt" ? " primary" : " danger") : ""}`}
              >
                {v === "exempt" ? `免核定（${poolCounts.exempt}，可一键过）` : `需核定（${poolCounts.need}，只能手审）`}
              </Link>
            ))}
            {pool && (
              <Link href="/admin/review?status=10" className="admin_btn">
                全部待审
              </Link>
            )}
            <span className="spacer" />
            <span className="label">
              {pool === "exempt" ? "零触发器命中 · 勾选后可批量通过（仍需先下载防盲审）" : pool === "need" ? "任一触发器命中 · 无勾选框，只能逐条手审" : "可切分拣池过滤"}
            </span>
          </div>
        )}

        <AdminReviewList
          key={`${status}_${pool}_${page}`}
          initial={list.rows}
          status={status}
          pool={pool}
          pendingTotal={ov.videoPending}
          poolCounts={status === VIDEO_STATUS.NORMAL ? poolCounts : { exempt: 0, need: 0 }}
          exemptTotal={pool === "exempt" ? list.total : undefined}
          needTotal={pool === "exempt" ? poolCounts.need : undefined}
        />

        {list.total > list.pageSize && (
          <div className="admin_pager">
            {/* 翻页必须带 pool：丢了会按默认落点逻辑跳回免核定池（2026-11-13 张老师报的翻页 bug） */}
            {page > 1 && <Link href={`/admin/review?status=${status}${pool ? `&pool=${pool}` : ""}&page=${page - 1}`}>上一页</Link>}
            <span className="current">{page}</span>
            {page * list.pageSize < list.total && (
              <Link href={`/admin/review?status=${status}${pool ? `&pool=${pool}` : ""}&page=${page + 1}`}>下一页</Link>
            )}
            <span style={{ border: 0, marginLeft: 12, color: "#75715e" }}>
              共 {Math.ceil(list.total / list.pageSize)} 页
            </span>
          </div>
        )}
      </AdminCard>

      <div className="admin_grid c2">
        <AdminCard title="最近7天审核量">
          <BarList
            items={workload7.map((w) => ({ label: auditors.get(w.user)?.chineseName ?? `#${w.user}`, value: w.count }))}
            color="linear-gradient(90deg,#1f6f8a,#66d9ef)"
            emptyText="近7天无审核记录"
          />
        </AdminCard>

        <AdminCard title="累计审核数量">
          <BarList
            items={workload.map((w) => ({ label: auditors.get(w.user)?.chineseName ?? `#${w.user}`, value: w.count }))}
            color="linear-gradient(90deg,#8a5a1f,#f79646)"
          />
        </AdminCard>
      </div>

      <AdminCard title="审核规则（机器只分拣、不审批——2026-10-19 自动分拣上线）">
        <div className="admin_note">
          · <b>免核定池</b>＝press-release / STNB / cls / path / 点击数五类触发器零命中 → 可勾选批量通过（仍需先下载，防盲审照旧）；<br />
          · <b>需核定池</b>＝任一触发器命中（触发原因见行内标签）→ 只能逐条手审，批量通过会被服务端拒绝；疑似作弊（多重命中）行内红标提示；<br />
          · <b>必须先在后台下载观看过该录像</b>才能审核，未下载的审核请求会被服务端拒绝（防盲审）。<br />
          · 已审核过的录像默认不可重审，只有超级管理员可以改判（改判会重算成绩与动态）。<br />
          · 通过 = 写入录像成绩表 → 更新玩家最好成绩 → 刷新纪录则发布动态；屏蔽 = 移除成绩并用次优录像顶替。<br />
          · 分拣触发原因仅后台展示，玩家端任何页面不可见。
        </div>
      </AdminCard>
    </div>
  );
}
