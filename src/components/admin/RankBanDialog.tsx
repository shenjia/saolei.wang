// 禁用排名模式弹窗（2026-10-29 张老师定：时长可选——24小时/7天/一个月/永久，默认 24 小时）
// 复用封禁弹窗（ban_*）样式；确认走 user.setRankBan（on=1 + duration key）。
// 「永久」落远期哨兵 RANK_BAN_PERMANENT（2100 年），解禁逻辑无需感知差异。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { RANK_BAN_DURATIONS } from "@/lib/config";

export function RankBanDialog({
  userId,
  name,
  sm = true,
}: {
  userId: number;
  name: string;
  sm?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState("24h"); // 默认 24 小时（与探测命中同款）
  const [busy, setBusy] = useState(false);

  const openDialog = () => {
    setDuration("24h");
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    const res = await postOp("user.setRankBan", { id: userId, on: 1, duration });
    setBusy(false);
    toast(res.ok ? res.message ?? "已禁用" : res.error ?? "操作失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  };

  return (
    <>
      <button type="button" className={`admin_btn warn${sm ? " sm" : ""}`} onClick={openDialog}>
        禁用排名模式
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>禁用排名模式</h1>
            <p className="ban_desc">
              玩家「{name}」（#{userId}）禁用后无法进入练习页排名模式对局，登录与录像上传不受影响。
            </p>

            <div className="ban_label">禁用时长</div>
            <div className="ban_dur">
              {RANK_BAN_DURATIONS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`ban_dur_opt${duration === key ? " on" : ""}`}
                  onClick={() => setDuration(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="ban_hint">
              选择时限时，到期自动解禁；选「永久」则只能手动解禁。低信任用户组状态不受影响。
            </p>

            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn danger" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : "确认禁用"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
