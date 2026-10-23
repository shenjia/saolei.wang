// 录像管理列表（客户端，2026-10-23）
// 2026-10-23 张老师调整：播放器入口独立成「播放」列（点击列前，弹全屏
// AdminVideoPlayer，与审核页同一套回放 UI，rmv/解析失败自动 flop 兜底）；
// 「时间」列成绩改回纯链接——新标签页打开前台录像详情页。
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
            {/* 时间列＝新标签页打开前台详情页；播放入口独立在「播放」列 */}
            <td className="num strong">
              {v.realTime ? (
                <a className="link" href={`/video/${v.id}`} target="_blank" rel="noopener" title="新标签页打开前台录像详情页">
                  {scoreTime(v.realTime)}
                </a>
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
            {/* 播放列（2026-10-23 张老师需求：点击列前，弹全屏播放器，与审核页同款按钮） */}
            <td className="c">
              {v.filepath && v.realTime ? (
                <button
                  type="button"
                  className={`admin_btn sm${v.watched ? "" : " primary"}`}
                  title={v.watched ? "已看过（点击再次播放）" : "点击弹层播放该录像"}
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
                  style={{ minWidth: 0, padding: "2px 8px" }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true" style={{ verticalAlign: "-1px", marginRight: 3 }}>
                    <path d="M7 4.8v14.4c0 .9 1 1.45 1.76.96l9.6-7.2a1.14 1.14 0 0 0 0-1.92l-9.6-7.2A1.14 1.14 0 0 0 7 4.8z" />
                  </svg>
                  {v.watched ? "已看" : "播放"}
                </button>
              ) : (
                <span className="sub" title="录像文件缺失或无解析信息">
                  —
                </span>
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
            <td colSpan={16}>
              <div className="admin_empty">没有符合条件的录像</div>
            </td>
          </tr>
        )}
      </tbody>
    </>
  );
}
