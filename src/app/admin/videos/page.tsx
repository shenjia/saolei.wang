// 管理后台 · 录像管理（2026-09-24）
// 全量录像检索与处置：级别 / 状态 / NF / 时间范围 / 玩家，行内可审核、下载、彻底删除。

import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { USER_ROLE, VIDEO_STATUS } from "@/lib/config";
import { getVideoListAdmin, type VideoFilter } from "@/lib/admin/data";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "录像管理 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminVideosPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = await getSession();
  const isSuper = session?.role === USER_ROLE.ADMINISTRATOR;

  const filter: VideoFilter = {
    q: sp.q,
    level: sp.level,
    status: sp.status,
    nf: sp.nf,
    from: sp.from,
    to: sp.to,
    order: sp.order,
    page: Math.max(1, parseInt(sp.page ?? "1", 10) || 1),
  };
  const { rows, total, pageSize, page } = await getVideoListAdmin(filter);

  return (
    <>
      <div className="admin_page_head">
        <h1>录像管理</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 条命中当前条件</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "录像 ID / 玩家 ID / 玩家姓名" },
              {
                name: "level",
                type: "select",
                prefix: "级别",
                options: [["", "全部级别"], ["beg", "初级"], ["int", "中级"], ["exp", "高级"]],
              },
              {
                name: "status",
                type: "select",
                prefix: "状态",
                options: [
                  ["", "全部状态"],
                  ["10", "待审核"],
                  ["20", "已通过"],
                  ["0", "已屏蔽"],
                ],
              },
              { name: "nf", type: "select", prefix: "玩法", options: [["", "全部"], ["0", "标雷"], ["1", "无标 NF"]] },
              {
                name: "order",
                type: "select",
                prefix: "排序",
                options: [
                  ["new", "最新上传"],
                  ["old", "最早上传"],
                  ["time", "用时最快"],
                  ["board", "3BV 最高"],
                  ["click", "点击最多"],
                ],
              },
              { name: "from", type: "date", prefix: "上传自" },
              { name: "to", type: "date", prefix: "至" },
            ]}
          />
        </Suspense>

        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>玩家</th>
                <th className="c">级别</th>
                <th className="num">时间</th>
                <th className="num">3BV/s</th>
                <th className="num">3BV</th>
                <th className="c">玩法</th>
                <th>软件</th>
                <th className="c">状态</th>
                <th>审核</th>
                <th className="num">点击</th>
                <th className="num">下载</th>
                <th className="num">评论</th>
                <th>上传</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className={v.status === 0 ? "off" : undefined}>
                  <td className="c">
                    <Link className="link" href={`/video/${v.id}`} target="_blank">
                      {v.id}
                    </Link>
                  </td>
                  <td>
                    <Link className="link" href={`/admin/users/${v.user}`}>
                      {v.author?.chineseName ?? `#${v.user}`}
                    </Link>
                  </td>
                  <td className="c">
                    <LevelTag level={v.level} />
                  </td>
                  <td className="num strong">{v.realTime ? scoreTime(v.realTime) : "—"}</td>
                  <td className="num">{v.board3bv && v.realTime ? score3bvs(Math.round((v.board3bv * 1e6) / v.realTime)) : "—"}</td>
                  <td className="num">{v.board3bv || "—"}</td>
                  <td className="c">{v.noflag ? <span className="admin_tag info">NF</span> : <span className="sub">标雷</span>}</td>
                  <td className="sub">{[v.software, v.version].filter(Boolean).join(" ") || "—"}</td>
                  <td className="c">
                    <StatusTag status={v.status} />
                  </td>
                  <td className="sub">
                    {v.reviewer ? (
                      <>
                        {v.reviewer.chineseName}
                        <br />
                        {v.reviewTime ? timeOpposite(v.reviewTime) : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">{v.clicks || "—"}</td>
                  <td className="num">{v.downloads || "—"}</td>
                  <td className="num">{v.comments || "—"}</td>
                  <td className="sub">{v.createTime ? timeOpposite(v.createTime) : "—"}</td>
                  <td className="ops">
                    {v.status !== VIDEO_STATUS.REVIEWED && (
                      <AdminAction
                        op="video.review"
                        params={{ id: v.id, status: VIDEO_STATUS.REVIEWED }}
                        label="通过"
                        variant="primary"
                        confirm={`确认通过录像 #${v.id}？将写入成绩并可能刷新纪录动态。`}
                      />
                    )}
                    {v.status !== VIDEO_STATUS.BANNED && (
                      <AdminAction
                        op="video.review"
                        params={{ id: v.id, status: VIDEO_STATUS.BANNED }}
                        label="屏蔽"
                        variant="danger"
                        confirm={`确认屏蔽录像 #${v.id}？该录像对应的最好成绩会被回退。`}
                      />
                    )}
                    {isSuper && (
                      <AdminAction
                        op="video.delete"
                        params={{ id: v.id }}
                        label="删除"
                        variant="danger"
                        confirm={`⚠️ 彻底删除录像 #${v.id}？将连带删除解析信息、评论与引用它的动态，不可恢复。`}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={15}>
                    <div className="admin_empty">没有符合条件的录像</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/videos" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="操作说明">
        <div className="admin_note">
          · <b>通过</b>会按审核管线写入录像成绩表、更新玩家最好成绩并发布纪录动态（与前台审核完全同一套逻辑）。<br />
          · <b>屏蔽</b>会把该录像从成绩表移除；若它是玩家的最好成绩，则自动用次优录像顶替，没有次优才清零。<br />
          · <b>删除</b>（仅超管）先执行屏蔽回退成绩，再清理 video / video_info / video_stat / 评论 / 引用动态，不可恢复。<br />
          · 审核管线要求「先下载观看再审核」，批量审核请到<Link href="/admin/review"> 审核管理 </Link>（那里带下载按钮与勾选）。
        </div>
      </AdminCard>
    </>
  );
}
