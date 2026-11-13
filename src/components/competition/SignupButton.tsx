// 比赛报名按钮（客户端）：未报名=绿色「报名参加」，点击调 /api/competition/join；
// 已报名=暗绿「已报名」不可再点。未登录由页面层渲染为登录跳转链接，不进本组件。

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

export function SignupButton({
  compId,
  joined,
  name,
}: {
  compId: string;
  joined: boolean;
  name: string; // 二次确认文案用（比赛全名）
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  if (joined) {
    return (
      <button type="button" className="comp_btn comp_btn_joined" disabled>
        已报名
      </button>
    );
  }

  return (
    <button
      type="button"
      className="comp_btn comp_btn_join"
      disabled={busy || pending}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch("/api/competition/join", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: compId }),
          });
          const data = (await res.json()) as { ok: boolean; error?: string };
          if (data.ok) {
            toast(`已报名「${name}」`, "success");
            startTransition(() => router.refresh());
          } else {
            toast(data.error ?? "报名失败，请重试", "error");
          }
        } catch {
          toast("网络错误，请重试", "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : "报名参加"}
    </button>
  );
}
