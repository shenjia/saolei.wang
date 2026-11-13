"use client";

// 比赛批量收录像弹窗（2026-11-13 三期张老师需求；23:27 张老师定：入口移到详情页录像列表标题右侧）
// 详情页录像列表「批量收录录像」→ 弹窗逐行输入录像 ID（一行一个，22:40 张老师定不用逗号）→ 一次性挂接到本比赛。
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

  // 一行一个 ID（张老师 22:40 定）；服务端兼容任意分隔，这里逐行解析并校验纯数字
  const validIds = [
    ...new Set(
      ids
        .split(/\n+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s)),
    ),
  ];
  const badLines = ids
    .split(/\n+/)
    .map((s, i) => ({ s: s.trim(), n: i + 1 }))
    .filter(({ s }) => s && !/^\d+$/.test(s))
    .map(({ n }) => n);

  const submit = async () => {
    if (validIds.length === 0) {
      toast("请输入至少一个录像 ID", "error");
      return;
    }
    if (badLines.length > 0) {
      toast(`第 ${badLines.join("、")} 行不是纯数字 ID，请检查`, "error");
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
        批量收录录像
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>批量收录录像</h1>
            <p className="ban_desc">
              比赛「{name}」（#{competitionId}）——每行输入一个录像 ID，
              已参与其他比赛的录像将静默转入本比赛。
            </p>
            <textarea
              className="admin_textarea"
              rows={8}
              placeholder={"一行一个录像 ID\n如：\n12345\n12346"}
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              style={{ width: "100%" }}
            />
            <p className="ban_hint">
              {badLines.length > 0
                ? `⚠️ 第 ${badLines.join("、")} 行不是纯数字 ID`
                : validIds.length > 0
                  ? `已识别 ${validIds.length} 个录像 ID`
                  : "一行一个 ID，自动去重"}
              {validIds.length > 500 ? "（单次最多 500 个）" : ""}
            </p>
            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn primary" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : `收录 ${validIds.length || ""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
