// 玩家管理 · 用户组视图的客户端小件（2026-10-27 用户组合并进玩家管理）
// · GroupSeenMark：组视图挂载即刷 localStorage 已读基线 + 广播事件让侧栏 badge 消失（不渲染 UI）；
// · GroupRowHighlight：新成员行加亮（加入时间晚于旧基线 → tr.ug_new，加亮判定用刷新前的旧基线，
//   ref 守卫防 React 严格模式 effect 双跑吞加亮）；
// · GroupRemoveBtn：移出按钮（可信组=setTrusted；低信任「反作弊标记」源=clearCheatPenalty），
//   confirmDialog 站内浮窗确认，成功后行就地隐藏 + 通知同页刷新。

"use client";

import { useEffect, useRef, useState } from "react";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { confirmDialog } from "@/components/Confirm";

const LS_KEY = "admin_group_seen_v1";

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

/** 组视图挂载：刷新已读基线（badge 消失）；渲染空占位 */
export function GroupSeenMark({ group, maxJoin, total }: { group: "trusted" | "lowtrust"; maxJoin: number; total: number }) {
  useEffect(() => {
    const seen = readSeen();
    seen[group] = Math.max(seen[group] ?? 0, maxJoin);
    seen[group + "_c"] = total;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(seen));
    } catch {
      /* 隐私模式写失败——无害 */
    }
    window.dispatchEvent(new CustomEvent("admin-group-seen", { detail: { group } }));
  }, [group, maxJoin, total]);
  return null;
}

/** 新成员行加亮包装：isNew 判定取挂载首帧的旧基线（GroupSeenMark 刷新前）。
 *  基线在 render 期锁定（早于一切 effect——GroupSeenMark 的刷基线 effect 不会影响它）；
 *  setIsNew 放 effect 里避免 SSR/hydration 的 className 不一致警告。 */
export function GroupRowHighlight({
  group,
  joinTime,
  children,
}: {
  group: "trusted" | "lowtrust";
  joinTime: number | null;
  children: React.ReactNode;
}) {
  const baseRef = useRef<number | null>(null);
  if (baseRef.current === null) {
    // SSR 无 localStorage：base=0（不加类）；hydration 在 render 期读到旧基线
    baseRef.current = typeof window === "undefined" ? 0 : readSeen()[group] ?? 0;
  }
  const [isNew, setIsNew] = useState(false);
  useEffect(() => {
    setIsNew((joinTime ?? 0) > baseRef.current!);
  }, [group, joinTime]);
  return <tr className={isNew ? "ug_new" : undefined}>{children}</tr>;
}

/** 移出按钮：可信组 / 低信任「反作弊标记」源 */
export function GroupRemoveBtn({
  id,
  name,
  mode,
}: {
  id: number;
  name: string;
  mode: "trusted" | "flag";
}) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return <span className="sub">已移出</span>;
  return (
    <button
      type="button"
      className="admin_btn sm"
      disabled={busy}
      onClick={async () => {
        const ok = await confirmDialog({
          title: "操作确认",
          message:
            mode === "flag"
              ? `确认把「${name}」移出低信任用户组？将清除其反作弊标记（排名模式与上传限制恢复），待审录像会立即重分拣。`
              : `确认把「${name}」移出可信用户组？其后续上传录像将恢复 STNB 触发器检查，待审录像会立即重分拣。`,
          danger: true,
        });
        if (!ok) return;
        setBusy(true);
        const res =
          mode === "flag"
            ? await postOp("user.clearCheatPenalty", { id })
            : await postOp("user.setTrusted", { id, trusted: false });
        setBusy(false);
        if (res.ok) {
          toast(res.message ?? "操作成功", "success");
          setGone(true);
        } else {
          toast(res.error ?? "操作失败", "error");
        }
      }}
    >
      {busy ? "…" : "移出用户组"}
    </button>
  );
}
