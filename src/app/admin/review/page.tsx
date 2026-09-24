// 管理后台 · 审核管理（2026-09-24）
// 待审队列 + 批量审核 + 审核积压监控；审核逻辑与前台 /video/review 完全同一套（lib/review.ts）。

import Link from "next/link";
import { getVideoListAdmin } from "@/lib/admin/data";
import { getAuditorWorkload, getOverview } from "@/lib/admin/stats";
import { usersByIds } from "@/lib/queries";
import { VIDEO_STATUS } from "@/lib/config";
import { AdminReviewList } from "@/components/admin/AdminReviewList";
import { AdminCard, Kpi, StatusTag } from "@/components/admin/Widgets";
import { BarList } from "@/components/admin/Charts";
import { scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "审核管理 | 管理后台" };

type SP = Record<string, string | undefined>;

const TABS: [string, string][] = [
  [String(VIDEO_STATUS.NORMAL), "待审核"],
  [String(VIDEO_STATUS.REVIEWED), "已通过"],
  [String(VIDEO_STATUS.BANNED), "已屏蔽"],
];

export default async function AdminReviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const status = ["10", "20", "0"].includes(sp.status ?? "") ? parseInt(sp.status!, 10) : VIDEO_STATUS.NORMAL;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [list, ov, workload] = await Promise.all([
    getVideoListAdmin({ status: String(status), order: status === VIDEO_STATUS.NORMAL ? "old" : "new", page }),
    getOverview(),
    getAuditorWorkload(6),
  ]);
  const auditors = await usersByIds(workload.map((w) => w.user));

  const pendingDays = ov.oldestPendingDays;

  const recent = list.rows.slice(0, 5);

  return (
    <>
      <div className="admin_page_head">
        <h1>审核管理</h1>
        <span className="sub">
          待审 {ov.videoPending} 条
          {ov.oldestPendingTime > 0 && ` · 最老一条上传于 ${timeOpposite(ov.oldestPendingTime, 0, "Y-m-d H:i")}（${pendingDays} 天前）`}
        </span>
        <div className="right">
          <Link className="admin_btn" href="/video/review" target="_blank">
            前台审核页
          </Link>
        </div>
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

      <AdminCard tight>
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

        <AdminReviewList key={`${status}_${page}`} initial={list.rows} status={status} />

        {list.total > list.pageSize && (
          <div className="admin_pager">
            {page > 1 && <Link href={`/admin/review?status=${status}&page=${page - 1}`}>上一页</Link>}
            <span className="current">{page}</span>
            {page * list.pageSize < list.total && (
              <Link href={`/admin/review?status=${status}&page=${page + 1}`}>下一页</Link>
            )}
            <span style={{ border: 0, marginLeft: 12, color: "#75715e" }}>
              共 {Math.ceil(list.total / list.pageSize)} 页
            </span>
          </div>
        )}
      </AdminCard>

      <div className="admin_grid c2">
        <AdminCard title="审核员工作量 Top 6">
          <BarList
            items={workload.map((w) => ({ label: auditors.get(w.user)?.chineseName ?? `#${w.user}`, value: w.count }))}
            color="linear-gradient(90deg,#8a5a1f,#f79646)"
          />
        </AdminCard>

        <AdminCard title="本页最近条目" tight>
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th className="c">ID</th>
                  <th>玩家</th>
                  <th className="num">时间</th>
                  <th className="c">状态</th>
                  <th>上传</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((v) => (
                  <tr key={v.id}>
                    <td className="c">
                      <Link className="link" href={`/video/${v.id}`} target="_blank">
                        {v.id}
                      </Link>
                    </td>
                    <td>{v.author?.chineseName ?? `#${v.user}`}</td>
                    <td className="num">{v.realTime ? scoreTime(v.realTime) : "—"}</td>
                    <td className="c">
                      <StatusTag status={v.status} />
                    </td>
                    <td className="sub">{timeOpposite(v.createTime)}</td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="admin_empty">暂无</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </AdminCard>
      </div>

      <AdminCard title="审核规则（移植 2013 版 Review::video）">
        <div className="admin_note">
          · <b>必须先在后台下载观看过该录像</b>才能审核，未下载的审核请求会被服务端拒绝（防盲审）；列表里「未下载 ⬇」即为提示。<br />
          · 已审核过的录像默认不可重审，只有超级管理员可以改判（改判会重算成绩与动态）。<br />
          · 通过 = 写入录像成绩表 → 更新玩家最好成绩 → 刷新纪录则发布动态；屏蔽 = 移除成绩并用次优录像顶替。<br />
          · 批量操作逐条调用同一审核管线，逐条独立成败，失败原因会在提示里汇总。
        </div>
      </AdminCard>
    </>
  );
}
