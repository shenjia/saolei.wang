// 审核按钮组（移植 views/video/_reviewPanel）
// 通过：当前状态不是已通过时显示（已屏蔽时再点通过需确认）
// 屏蔽：当前状态不是已屏蔽时显示（总是需确认）

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VIDEO_STATUS } from "@/lib/config";

export function ReviewButtons({
  videoId,
  status,
  onDone,
}: {
  videoId: number;
  status: number;
  onDone?: (newStatus: number) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function review(target: number) {
    const needConfirm =
      target === VIDEO_STATUS.BANNED || status === VIDEO_STATUS.BANNED;
    if (needConfirm && !window.confirm(target === VIDEO_STATUS.BANNED ? "确定屏蔽该录像？" : "确定恢复该录像？")) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/video/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: videoId, status: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "审核失败");
        return;
      }
      onDone?.(target);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="review_panel">
      {status !== VIDEO_STATUS.REVIEWED && (
        <button type="button" className="button small active" disabled={busy} onClick={() => review(VIDEO_STATUS.REVIEWED)}>
          通过
        </button>
      )}
      {status !== VIDEO_STATUS.BANNED && (
        <button type="button" className="button small danger" disabled={busy} onClick={() => review(VIDEO_STATUS.BANNED)}>
          屏蔽
        </button>
      )}
      {error && <span className="error"> {error}</span>}
    </span>
  );
}
