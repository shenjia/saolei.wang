// 移出低信任用户组弹窗（2026-10-27 张老师定：组内每行都是「移出」，两种语义在弹窗里选）
//
// 默认只移出组：清反作弊标记 + 记人工移出时刻（屏蔽史豁免），名下被屏蔽录像保持屏蔽；
// 勾选「同时解除屏蔽」才把独立屏蔽的录像恢复为通过（成绩回榜、参与排名）。
// 走 user.clearCheatPenalty（列表与玩家详情页共用同一 op，日志记「移出低信任用户组」）。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";

export function LowTrustDialog({
  userId,
  name,
  blockedCount,
  sm = true,
  label = "移出用户组",
  onDone,
}: {
  userId: number;
  name: string;
  /** 名下独立屏蔽录像部数（>0 才给「同时解除屏蔽」勾选） */
  blockedCount: number;
  sm?: boolean;
  label?: string;
  onDone?: (ok: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);

  const openDialog = () => {
    setRestore(false);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    const res = await postOp("user.clearCheatPenalty", { id: userId, restoreBlocked: restore });
    setBusy(false);
    toast(res.ok ? res.message ?? "已移出" : res.error ?? "操作失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      onDone?.(true);
      router.refresh();
    } else {
      onDone?.(false);
    }
  };

  return (
    <>
      <button type="button" className={`admin_btn warn${sm ? " sm" : ""}`} onClick={openDialog}>
        {label}
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>移出低信任用户组</h1>
            <p className="ban_desc">
              玩家「{name}」（#{userId}）移出后：上传录像不再强制人工审核、不再限流（每日 5 部），
              练习页排名模式立即恢复；其待审录像会立即重新分拣。
            </p>

            {blockedCount > 0 && (
              <label className="ban_check">
                <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} />
                <span>
                  同时解除其名下 <b>{blockedCount}</b> 部被屏蔽录像的屏蔽（恢复为通过，成绩重新入榜并参与排名；
                  封禁连坐的录像不在此列，归解禁流程恢复）
                </span>
              </label>
            )}
            {blockedCount > 0 && !restore && (
              <p className="ban_hint">
                不勾选则只移出用户组：被屏蔽的录像保持屏蔽（前台仍不可见、成绩不入榜），只是不再据此把该玩家当低信任对待。
              </p>
            )}
            <p className="ban_hint">之后该玩家再有录像被屏蔽时，会弹出「是否加入低信任用户组」确认，由管理员当场选择。</p>

            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn danger" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : "确认移出"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
