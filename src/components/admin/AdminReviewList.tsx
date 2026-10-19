// 审核队列（客户端，2026-09-24；2026-10-19 接自动分拣池）
//
// 与前台 /video/review 的关键差异：这里带「下载」入口与勾选批量操作。
// 审核管线的硬性规则是「必须先下载观看才能审核」（防盲审），所以每行会明确标出
// 是否已下载——未下载时点通过会被服务端拒绝，这里提前给视觉提示。
//
// 自动分拣（2026-10-19 方案 v2）：机器只分拣、不审批。
// · pool="exempt"（免核定池）→ 显示勾选框，可批量一键通过；
// · pool="need"（需核定池）→ 无勾选框，行内展示触发原因标签，只能逐条手审；
// · 无 pool（全部待审）→ 按行内标注混合展示：需核定行隐藏勾选框。

"use client";

import Link from "next/link";
import { useState } from "react";
import type { AdminVideoRow } from "@/lib/admin/data";
import { LevelTag, StatusTag } from "./Widgets";
import { postOp, useOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { VIDEO_STATUS } from "@/lib/config";

/** auto_reason 位码 → 后台标签（cheat 类红 / 价值类青 / 信任类紫 / 系统灰） */
const REASON_BITS: [number, string, string][] = [
  [1 << 0, "press≤阈值", "cheat"],
  [1 << 1, "STNB分位", "val"],
  [1 << 2, "cls>10", "cheat"],
  [1 << 3, "path=0", "cheat"],
  [1 << 4, "点击数不足", "cheat"],
  [1 << 6, "破纪录", "val"],
  [1 << 7, "TOP榜", "val"],
  [1 << 8, "首次入伍", "val"],
  [1 << 9, "低信任", "trust"],
];

function ReasonTags({ reason }: { reason: number }) {
  const tags = REASON_BITS.filter(([bit]) => (reason & bit) !== 0);
  if (!tags.length) return <span className="sub">—</span>;
  const cheatHits = tags.filter(([, , cls]) => cls === "cheat").length;
  return (
    <>
      {cheatHits >= 2 && <span className="admin_tag bad">疑似作弊</span>}{" "}
      {tags.map(([, label, cls]) => (
        <span key={label} className={`admin_tag ${cls === "cheat" ? "bad" : cls === "trust" ? "warn" : cls === "val" ? "info" : "plain"}`}>
          {label}
        </span>
      ))}
    </>
  );
}

export function AdminReviewList({
  initial,
  status,
  pool,
}: {
  initial: AdminVideoRow[];
  status: number;
  pool?: string;
}) {
  const [items, setItems] = useState(initial);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  // 可勾选的行：免核定池（或未分池视图里的免核定行）且仍待审
  const pickable = (v: AdminVideoRow) =>
    status === VIDEO_STATUS.NORMAL && v.autoFlag === 1;

  const drop = (ids: number[]) => setItems((prev) => prev.filter((i) => !ids.includes(i.id)));

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickableItems = items.filter(pickable);
  const allOn = pickableItems.length > 0 && picked.size === pickableItems.length;
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(pickableItems.map((i) => i.id)));

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

  const showBatchBar = status === VIDEO_STATUS.NORMAL && (pool === undefined || pool === "exempt") && items.length > 0;

  return (
    <>
      {showBatchBar && (
        <div className="admin_filterbar">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#939387" }}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} style={{ width: 14, height: 14 }} />
            全选免核定
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
              <th className="num">STNB</th>
              <th className="c">玩法</th>
              <th>软件</th>
              <th className="c">分拣</th>
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
                showPick={pickable(v)}
                picked={picked.has(v.id)}
                onToggle={() => toggle(v.id)}
                onRemoved={() => drop([v.id])}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={14}>
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
  // 需核定行（含未分拣/失败保守处理）微红底提示
  const needRow = v.autoFlag !== 1;
  return (
    <tr style={needRow ? { background: "rgba(249,38,114,.05)" } : undefined}>
      {showPick ? (
        <td className="c">
          <input
            type="checkbox"
            checked={picked}
            onChange={onToggle}
            style={{ width: 14, height: 14 }}
            aria-label={`选择录像 ${v.id}`}
          />
        </td>
      ) : (
        <td className="c sub" title="需核定：只能逐条手审">🔒</td>
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
      <td className="num">{v.stnb != null ? v.stnb.toFixed(1) : "—"}</td>
      <td className="c">{v.noflag ? <span className="admin_tag info">NF</span> : <span className="sub">标雷</span>}</td>
      <td className="sub">{[v.software, v.version].filter(Boolean).join(" ") || "—"}</td>
      <td className="c">
        {v.autoFlag === 1 ? (
          <span className="admin_tag ok">免核定</span>
        ) : v.autoFlag === 2 ? (
          <span className="admin_tag plain" title="分拣失败，按需核定">需核定·失败</span>
        ) : v.autoFlag === -1 ? (
          <span className="admin_tag plain" title="历史存量未分拣，保守需核定">需核定·未分拣</span>
        ) : (
          <ReasonTags reason={v.autoReason} />
        )}
      </td>
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
