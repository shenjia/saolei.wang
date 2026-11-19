"use client";

// 维护模式开关（2026-10-22）：管理后台 · 系统信息页「功能开关」卡片内。
// 仅超级管理员可操作（op 层 administrator 权限兜底，前端只做交互）；
// 开启需二次确认——它会停掉全站用户写入口。

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { confirmDialog } from "@/components/Confirm";

export default function MaintenanceSwitch({ initialOn }: { initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [busy, startTransition] = useTransition();
  const router = useRouter();

  async function toggle() {
    const next = !on;
    if (next && !(await confirmDialog({ title: "开启维护模式", message: "开启后全站用户将无法注册、上传录像、发帖回帖、评论、私信，直到关闭为止。", danger: true }))) {
      return;
    }
    const res = await fetch("/api/admin/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "site.setMaintenance", on: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast(data.error ?? "操作失败", "error", 5000);
      return;
    }
    setOn(next);
    startTransition(() => router.refresh());
  }

  return (
    <>
      {on ? <span className="admin_tag bad">维护中</span> : <span className="admin_tag ok">正常</span>}{" "}
      <button type="button" className="admin_btn sm" onClick={toggle} disabled={busy}>
        {on ? "关闭维护模式" : "开启维护模式"}
      </button>
    </>
  );
}
