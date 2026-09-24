// 审核队列（客户端，2026-09-24）
//
// 与前台 /video/review 的关键差异：这里带「下载」入口与勾选批量操作。
// 审核管线的硬性规则是「必须先下载观看才能审核」（防盲审），所以每行会明确标出
// 是否已下载——未下载时点通过会被服务端拒绝，这里提前给视觉提示。

"use client";

import Link from "next/link";
import { useState } from "react";
import type { AdminVideoRow } from "@/lib/admin/data";
import { LevelTag, StatusTag } from "./Widgets";
import { postOp, useOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { VIDEO_STATUS } from "@/lib/config";

export function AdminReviewList({ initial, status }: { initial: AdminVideoRow[]; status: number }) {
  const [items, setItems] = useState(initial);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const drop = (ids: number[]) => setItems((prev) => prev.filter((i) => !ids.includes(i.id)));

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOn = items.length > 0 && picked.size === items.length;
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(items.map((i) => i.id)));

  const batch = async (nextStatus: number) => {
    const ids = [...picked];
    if (!ids.length) return;
    const label = nextStatus === VIDEO_STATUS.REVIEWED ? "通过" : "屏蔽";
    if (!window.confirm(`确认批量${label}选中的 ${ids.length} 条录像？`)) return;
    setBusy(true);
    const res = await postOp("video.batchReview", { ids, status: nextStatus });
    setBusy(false);
    toast(res.ok ? res.message ?? "批量完成" : res.error ?? "批量失败", res.ok ? "success" : "error");
    if (res.ok) {
      drop(ids);
      setPicked(new Set());
    }
  };

  return (
    <>
      {status === VIDEO_STATUS.NORMAL && items.length > 0 && (
        <div className="admin_filterbar">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#939387" }}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} style={{ width: 14, height: 14 }} />
            全选当前页
          </label>
          <span className="label">已选 {picked.size} 条</span>
          <span className="spacer" />
          <button
            type="button"
            className="admin_btn primary"
            disabled={busy || !picked.size}
            onClick={() => batch(VIDEO_STATUS.REVIEWED)}
          >
            批量通过
          </button>
          <button
            type="button"
            className="admin_btn danger"
            disabled={busy || !picked.size}
            onClick={() => batch(VIDEO_STATUS.BANNED)}
          >
            批量屏蔽
          </button>
          {picked.size > 0 && (
            <button type="button" className="admin_btn" onClick={() => setPicked(new Set())}>
              取消选择
            </button>
          )}
        </div>
      )}

      <div className="admin_scroll">
        <table className="admin_table">
          <thead>
            <tr>
              {status === VIDEO_STATUS.NORMAL && <th style={{ width: 36 }} />}
              <th className="c">ID</th>
              <th>玩家</th>
              <th className="c">级别</th>
              <th className="num">时间</th>
              <th className="num">3BV/s</th>
              <th className="num">3BV</th>
              <th className="c">玩法</th>
              <th>软件</th>
              <th className="c">下载</th>
              <th className="c">状态</th>
              <th>上传时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <ReviewRow
                key={v.id}
                video={v}
                showPick={status === VIDEO_STATUS.NORMAL}
                picked={picked.has(v.id)}
                onToggle={() => toggle(v.id)}
                onRemoved={() => drop([v.id])}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={status === VIDEO_STATUS.NORMAL ? 13 : 12}>
                  <div className="admin_empty">该状态下没有录像</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReviewRow({
  video: v,
  showPick,
  picked,
  onToggle,
  onRemoved,
}: {
  video: AdminVideoRow;
  showPick: boolean;
  picked: boolean;
  onToggle: () => void;
  onRemoved: () => void;
}) {
  const { run, busy } = useOp();
  return (
    <tr>
      {showPick && (
        <td className="c">
          <input
            type="checkbox"
            checked={picked}
            onChange={onToggle}
            style={{ width: 14, height: 14 }}
            aria-label={`选择录像 ${v.id}`}
          />
        </td>
      )}
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
        {v.downloads > 0 ? (
          <a className="admin_tag ok" href={`/video/download/${v.id}`} title="再次下载">
            已下载
          </a>
        ) : (
          <a className="admin_tag wait" href={`/video/download/${v.id}`} title="必须下载观看后才能审核">
            未下载 ⬇
          </a>
        )}
      </td>
      <td className="c">
        <StatusTag status={v.status} />
      </td>
      <td className="sub">{v.createTime ? timeOpposite(v.createTime) : "—"}</td>
      <td className="ops">
        <a className="admin_btn sm" href={`/video/download/${v.id}`}>
          下载
        </a>
        {v.status !== VIDEO_STATUS.REVIEWED && (
          <button
            type="button"
            className="admin_btn primary sm"
            disabled={busy}
            onClick={async () => {
              const ok = await run("video.review", { id: v.id, status: VIDEO_STATUS.REVIEWED });
              if (ok) onRemoved();
            }}
          >
            通过
          </button>
        )}
        {v.status !== VIDEO_STATUS.BANNED && (
          <button
            type="button"
            className="admin_btn danger sm"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`确认屏蔽录像 #${v.id}？对应最好成绩会被回退。`)) return;
              const ok = await run("video.review", { id: v.id, status: VIDEO_STATUS.BANNED });
              if (ok) onRemoved();
            }}
          >
            屏蔽
          </button>
        )}
      </td>
    </tr>
  );
}
