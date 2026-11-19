// 封禁账号弹窗（2026-10-16 限时封禁，张老师定稿样式见当日高保真稿）
// 点「封禁」弹出：时长单选（一天/一周/一月/一年/永久，默认永久）
// + 「同步封禁录像」勾选（打开时 GET /api/admin/ban-info 取可封录像数，默认不勾=不动录像）。
// 确认走 user.setStatus（duration + banVideos）；解禁时连坐录像按 status_bak 自动恢复。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { BAN_DURATIONS } from "@/lib/config";

export function BanUserDialog({
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
  const [duration, setDuration] = useState("0"); // 默认永久
  const [banVideos, setBanVideos] = useState(false); // 默认不动录像（张老师：勾选确认后才封）
  const [activeVideos, setActiveVideos] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const openDialog = async () => {
    setDuration("0");
    setBanVideos(false);
    setActiveVideos(null);
    setOpen(true);
    try {
      const res = await fetch(`/api/admin/ban-info?userId=${userId}`);
      const data = (await res.json()) as { ok: boolean; activeVideos?: number };
      if (data.ok) setActiveVideos(data.activeVideos ?? 0);
    } catch {
      /* 数目取不到不阻断封禁，勾选文案降级为「全部录像」 */
    }
  };

  const submit = async () => {
    setBusy(true);
    const res = await postOp("user.setStatus", { id: userId, status: -1, duration, banVideos });
    setBusy(false);
    toast(res.ok ? res.message ?? "已封禁" : res.error ?? "操作失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  };

  return (
    <>
      <button type="button" className={`admin_btn danger${sm ? " sm" : ""}`} onClick={openDialog}>
        封禁{sm ? "" : "账号"}
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>封禁账号</h1>
            <p className="ban_desc">
              玩家「{name}」（#{userId}）封禁后无法登录、不参与排行，已有成绩保留。
            </p>

            <div className="ban_label">封禁时长</div>
            <div className="ban_dur">
              {BAN_DURATIONS.map(([key, label]) => (
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

            <label className="ban_check">
              <input
                type="checkbox"
                checked={banVideos}
                onChange={(e) => setBanVideos(e.target.checked)}
              />
              <span>
                同时封禁该玩家发表的{" "}
                <b>{activeVideos === null ? "…" : activeVideos}</b>{" "}
                部录像（全站隐藏；解禁时自动恢复，单独屏蔽的不受影响）
              </span>
            </label>
            <p className="ban_hint">
              选择时限时，到期自动解禁并恢复连坐录像；选「永久」则只能手动解封。
            </p>

            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn danger" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : "确认封禁"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
