"use client";

// 完赛名单弹层（2026-11-22 张老师需求）：后台比赛清单「完赛人数」可点击，
// 弹层展示完赛玩家名单——赞助按完赛名单发放，名单要能一眼核对人。
// 名单由 RSC 页面一次算齐直传（不另起接口）；0 人时数字不可点。
// 视觉复用暗玻璃弹窗（.ban_overlay/.ban_dialog，ApiKeyDialog 同款）。

import { useState } from "react";

export function FinisherListPopover({
  count,
  names,
}: {
  /** 完赛人数（RSC 直传） */
  count: number;
  /** 完赛玩家中文名列表（与 count 同序；查无昵称兜底 UID） */
  names: string[];
}) {
  const [open, setOpen] = useState(false);

  if (count <= 0) return <span className="sub">0</span>;
  return (
    <>
      <button
        type="button"
        className="link"
        style={{ cursor: "pointer" }}
        title="点击查看完赛名单"
        onClick={() => setOpen(true)}
      >
        {count}
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>完赛名单（{count} 人）</h1>
            <p className="ban_desc">所有级别录像数量都满足要求、无任何保底成绩的玩家。</p>
            <ul className="finisher_list">
              {names.map((n, i) => (
                <li key={`${i}-${n}`}>{n}</li>
              ))}
            </ul>
            <div className="ban_ops">
              <button type="button" className="admin_btn primary" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
