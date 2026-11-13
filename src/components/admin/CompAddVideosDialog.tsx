"use client";

// 比赛批量收录像弹窗（2026-11-13 三期张老师需求）
// 清单行「收录像」→ 弹窗输入多个录像 ID（逗号/空格/换行分隔）→ 一次性挂接到本比赛。
// 已挂其他比赛的静默转入（张老师原话口径），服务端 competition.addVideos 兜底校验。
// 弹窗样式复用 ban_overlay / ban_dialog（封禁弹窗同款）。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";

export function CompAddVideosDialog({
  competitionId,
  name,
}: {
  competitionId: number;
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = [...new Set(ids.split(/[^\d]+/).filter(Boolean))];

  const submit = async () => {
    if (parsed.length === 0) {
      toast("请输入至少一个录像 ID", "error");
      return;
    }
    setBusy(true);
    const res = await postOp("competition.addVideos", { id: competitionId, ids });
    setBusy(false);
    toast(res.ok ? res.message ?? "已收录" : res.error ?? "操作失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      setIds("");
      router.refresh();
    }
  };

  return (
    <>
      <button type="button" className="admin_btn sm" onClick={() => setOpen(true)}>
        收录像
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>批量收录像</h1>
            <p className="ban_desc">
              比赛「{name}」（#{competitionId}）——输入要收录的录像 ID，
              已参与其他比赛的录像将静默转入本比赛。
            </p>
            <textarea
              className="admin_textarea"
              rows={5}
              placeholder={"录像 ID，逗号 / 空格 / 换行分隔均可\n如：12345 12346, 12347"}
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              style={{ width: "100%" }}
            />
            <p className="ban_hint">
              {parsed.length > 0 ? `已识别 ${parsed.length} 个录像 ID` : "支持任意非数字分隔符，自动去重"}
              {parsed.length > 500 ? "（单次最多 500 个）" : ""}
            </p>
            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn primary" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : `收录 ${parsed.length || ""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
