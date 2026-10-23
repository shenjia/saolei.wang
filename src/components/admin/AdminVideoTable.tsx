// 录像管理列表（客户端，2026-10-23）
// 与审核页 AdminReviewList 同款播放逻辑（张老师需求）：点「时间」列成绩 →
// 弹全屏播放器 AdminVideoPlayer（前台同一套回放 UI，rmv/解析失败自动 flop 兜底）。
// RSC 页面无法传回调，故表格主体 tbody 收进本客户端组件；thead/筛选/分页仍留服务端页面。
// 播放器内看过会静默 markWatched，与审核页防盲审口径一致（全量检索场景仅计数展示，不做限制）。

"use client";

import Link from "next/link";
import { useState } from "react";
import type { AdminVideoRow } from "@/lib/admin/data";
import { LevelTag, StatusTag } from "./Widgets";
import { AdminAction } from "./AdminAction";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { VIDEO_STATUS, type VideoLevel } from "@/lib/config";
import { AdminVideoPlayer, type AdminPlayerTarget } from "./AdminVideoPlayer";

export function AdminVideoTable({ rows, isSuper }: { rows: AdminVideoRow[]; isSuper: boolean }) {
  /** 全屏回放播放器（点时间列弹出，Esc/关闭按钮退出） */
  const [playTarget, setPlayTarget] = useState<AdminPlayerTarget | null>(null);

  return (
    <>
      {/* 全屏回放播放器（与审核页同一组件） */}
      <AdminVideoPlayer target={playTarget} onClose={() => setPlayTarget(null)} />

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
            {/* 时间列＝播放入口（与审核页一致：点击弹层播放，中键/右键仍可新开详情页） */}
            <td className="num strong">
              {v.realTime && v.filepath ? (
                <a
                  className="link"
                  href={`/video/${v.id}`}
                  target="_blank"
                  title="点击弹层播放该录像"
                  onClick={(e) => {
                    e.preventDefault();
                    setPlayTarget({
                      id: v.id,
                      level: v.level as VideoLevel,
                      filepath: v.filepath,
                      realTime: v.realTime,
                      player: v.author?.chineseName ?? `#${v.user}`,
                    });
                  }}
                >
                  {scoreTime(v.realTime)}
                </a>
              ) : v.realTime ? (
                scoreTime(v.realTime)
              ) : (
                "—"
              )}
            </td>
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
    </>
  );
}
