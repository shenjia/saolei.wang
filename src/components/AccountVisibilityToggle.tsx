"use client";

// 账户设置行内滑块开关（2026-11-10 张老师）：年龄/星座/赞助金额行尾各一个
// 「在主页展示xx」开关（由 2026-11-04 页面底部两个独立开关改造而来，交互同款；
// 2026-11-10 二改：文案分列为「在主页展示年龄/星座/金额」，一律靠右对齐）。
// 开=在我的主页展示（默认）；关=隐藏。提交 POST { field, hidden } 到
// /api/account/visibility，失败回弹原状态并 toast。

import { useState } from "react";
import { toast } from "@/components/Toast";

export function AccountVisibilityToggle({
  field,
  label,
  switchText,
  initialHidden,
}: {
  /** age | constellation | donate（对应 /api/account/visibility 的 field） */
  field: "age" | "constellation" | "donate";
  /** toast 文案里的行名（如「年龄」） */
  label: string;
  /** 开关右侧文案（2026-11-10 二改：在主页展示年龄 / 在主页展示星座 / 在主页展示金额） */
  switchText: string;
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
      const res = await fetch("/api/account/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, hidden: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setHidden(!next);
        toast(data.error ?? "保存失败，请重试", "error");
      } else {
        toast(next ? `已关闭「${switchText}」` : `已开启「${switchText}」`, "success");
      }
    } catch {
      setHidden(!next);
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="acct_gsw acct_row_gsw">
      <input type="checkbox" checked={!hidden} disabled={busy} onChange={() => void toggle()} />
      <span className="track" />
      <span className="txt">{switchText}</span>
    </label>
  );
}
