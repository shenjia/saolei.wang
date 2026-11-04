"use client";

// 账户设置通用滑块开关（2026-11-04）：由公开赞助金额开关泛化而来（交互/样式同款）。
// 开=公开（默认）；关=隐藏。提交 POST { hidden } 到指定 endpoint，失败回弹原状态并 toast。
// 现有两个实例：显示年龄与星座（/api/account/birth-visibility）、公开赞助金额（/api/account/donate-visibility）。

import { useState } from "react";
import { toast } from "@/components/Toast";

export function AccountVisibilityToggle({
  endpoint,
  label,
  hint,
  initialHidden,
}: {
  endpoint: string;
  label: string;
  hint: string;
  initialHidden: boolean;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    const next = !hidden;
    setBusy(true);
    // 乐观更新：先切 UI，失败回弹
    setHidden(next);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setHidden(!next);
        toast(data.error ?? "保存失败，请重试", "error");
      } else {
        toast(next ? `已关闭${label}` : `已开启${label}`, "success");
      }
    } catch {
      setHidden(!next);
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct_donate_row">
      <label className="acct_gsw">
        <input type="checkbox" checked={!hidden} disabled={busy} onChange={() => void toggle()} />
        <span className="track" />
        <span className="txt">{label}</span>
      </label>
      <span className="hint">{hint}</span>
    </div>
  );
}
