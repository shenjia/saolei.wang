// 后台头像审核列表（2026-09-24）
// 待审队列逐张过目：缩略图点击放大 → 通过 / 驳回（驳回需填原因，会发站内信通知用户）。
// 已通过列表额外支持「驳回」，会连带把 user.avatar 回滚到上传前的值（服务端判断是否正在生效）。

"use client";

import Link from "next/link";
import { useState } from "react";
import { useOp } from "./AdminAction";
import { AVATAR_CATEGORY_NAMES, AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { timeOpposite } from "@/lib/format";
import type { AdminAvatarRow } from "@/lib/admin/data";

export function AdminAvatarList({
  initial,
  status,
}: {
  initial: AdminAvatarRow[];
  status: number;
}) {
  const { run, busy } = useOp();
  const [zoom, setZoom] = useState<AdminAvatarRow | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  async function act(id: number, action: "approve" | "reject", text = "") {
    const ok = await run("avatar.review", { id, action, reason: text });
    if (ok) {
      setRejectingId(null);
      setReason("");
    }
  }

  if (!initial.length) {
    return <div className="admin_empty">暂无记录</div>;
  }

  return (
    <>
      <div className="admin_scroll">
        <table className="admin_table admin_avatar_table">
          <thead>
            <tr>
              <th className="c">头像</th>
              <th>玩家</th>
              <th className="c">上传时间</th>
              <th>AI 初审</th>
              {status !== AVATAR_REVIEW_STATUS.PENDING && <th className="c">审核人</th>}
              <th className="c">操作</th>
            </tr>
          </thead>
          <tbody>
            {initial.map((row) => (
              <tr key={row.id}>
                <td className="c">
                  <button
                    type="button"
                    className="admin_avatar_thumb"
                    onClick={() => setZoom(row)}
                    title="点击放大"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={row.filepath} alt="" />
                  </button>
                </td>
                <td>
                  <Link className="link" href={`/user/${row.user}`} target="_blank">
                    {row.author?.chineseName ?? `#${row.user}`}
                  </Link>
                  <span className="admin_hint"> #{row.user}</span>
                </td>
                <td className="c sub">{timeOpposite(row.createTime)}</td>
                <td>
                  <AiVerdict row={row} />
                </td>
                {status !== AVATAR_REVIEW_STATUS.PENDING && (
                  <td className="c sub">
                    {row.reviewer === 0 ? (
                      <span className="admin_tag plain">AI 自动</span>
                    ) : (
                      <>
                        {row.reviewerName || `#${row.reviewer}`}
                        <br />
                        <span className="admin_hint">{timeOpposite(row.reviewTime)}</span>
                      </>
                    )}
                  </td>
                )}
                <td className="c">
                  {rejectingId === row.id ? (
                    <div className="admin_reject_box">
                      <input
                        className="admin_input"
                        placeholder="驳回原因（会通知用户）"
                        value={reason}
                        autoFocus
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <button
                        type="button"
                        className="admin_btn danger sm"
                        disabled={busy}
                        onClick={() => act(row.id, "reject", reason)}
                      >
                        确认驳回
                      </button>
                      <button
                        type="button"
                        className="admin_btn sm"
                        onClick={() => {
                          setRejectingId(null);
                          setReason("");
                        }}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      {row.status !== AVATAR_REVIEW_STATUS.APPROVED && (
                        <button
                          type="button"
                          className="admin_btn primary sm"
                          disabled={busy}
                          onClick={() => act(row.id, "approve")}
                        >
                          通过
                        </button>
                      )}{" "}
                      {row.status !== AVATAR_REVIEW_STATUS.REJECTED && (
                        <button
                          type="button"
                          className="admin_btn danger sm"
                          disabled={busy}
                          onClick={() => {
                            setRejectingId(row.id);
                            setReason("");
                          }}
                        >
                          {row.status === AVATAR_REVIEW_STATUS.APPROVED ? "撤销并驳回" : "驳回"}
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {zoom && (
        <div className="admin_lightbox" onClick={() => setZoom(null)}>
          <div className="admin_lightbox_inner" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={zoom.filepath} alt={`#${zoom.user} 的头像`} />
            <div className="meta">
              <b>{zoom.author?.chineseName ?? `#${zoom.user}`}</b>
              <span> 上传于 {timeOpposite(zoom.createTime)}</span>
              {zoom.verdict && (
                <span>
                  {" "}
                  · AI：
                  {AVATAR_CATEGORY_NAMES[zoom.category] || zoom.category || "—"}
                  {zoom.reason ? `（${zoom.reason}）` : ""}
                </span>
              )}
            </div>
            <button type="button" className="admin_btn sm" onClick={() => setZoom(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** AI 初审意见：结论标签 + 风险分类 + 说明；未启用/异常/超时也如实展示，管理员据此决定是否放行 */
function AiVerdict({ row }: { row: AdminAvatarRow }) {
  const cat = AVATAR_CATEGORY_NAMES[row.category];
  const risky = !!row.category && row.category !== "ok";
  const degraded =
    row.source === "disabled"
      ? "AI 未启用"
      : row.source === "timeout"
        ? "AI 超时"
        : row.source === "error"
          ? "AI 异常"
          : "";
  return (
    <div className="admin_ai_verdict">
      {row.verdict === "pass" ? (
        <span className="admin_tag ok">AI 放行</span>
      ) : degraded ? (
        <span className="admin_tag plain">{degraded}</span>
      ) : (
        <span className="admin_tag wait">AI 存疑</span>
      )}{" "}
      {risky && <span className="admin_tag bad">{cat}</span>}
      <div className="admin_hint">{row.reason || "—"}</div>
    </div>
  );
}
