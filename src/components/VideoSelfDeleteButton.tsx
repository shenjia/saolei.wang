// 屏蔽录像本人自助删除按钮（2026-10-23 张老师需求）
// 仅在「本人查看自己被屏蔽的录像详情页」渲染（页面侧判定），下载按钮旁红色小按钮。
// 点击 → confirm 二次确认 → POST /api/video/self-delete → 成功跳回个人主页录像版块。
// 服务端权限铁闸：仅录像主人本人 + status=0（屏蔽态）可删（见 api/video/self-delete）。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "./Confirm";

export function VideoSelfDeleteButton({ videoId, userId }: { videoId: number; userId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (
      !(await confirmDialog({
        title: "删除录像",
        message: (
          <>
            确认彻底删除录像 <em>#{videoId}</em>？
            {"\n"}
            删除后该录像及其全部评论、相关动态将一并消失，<em>不可恢复</em>。
          </>
        ),
        confirmText: "删除",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/video/self-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: videoId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        window.alert(data.error ?? "删除失败，请稍后再试");
        setBusy(false);
        return;
      }
      // 删除成功：跳回个人主页录像版块（屏蔽盘已随之消失）
      router.push(`/user/${userId}#user_videos`);
    } catch {
      window.alert("网络错误，请重试");
      setBusy(false);
    }
  }

  return (
    <button type="button" className="button danger" disabled={busy} onClick={onDelete}>
      {busy ? "删除中…" : "删除"}
    </button>
  );
}
