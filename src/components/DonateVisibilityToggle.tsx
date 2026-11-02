"use client";

// 公开赞助金额开关（2026-11-02 张老师）：账户设置页最下方的滑块开关。
// 开=公开（个人主页数据统计展示赞助金额行，默认）；关=隐藏。
// 提交 /api/account/donate-visibility，失败回弹原状态并 toast。

import { useState } from "react";
import { toast } from "@/components/Toast";

export function DonateVisibilityToggle({ initialHidden }: { initialHidden: boolean }) {
  const [hidden, setHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    const next = !hidden;
    setBusy(true);
    // 乐观更新：先切 UI，失败回弹
    setHidden(next);
    try {
      const res = await fetch("/api/account/donate-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setHidden(!next);
        toast(data.error ?? "保存失败，请重试", "error");
      } else {
        toast(next ? "已关闭公开赞助金额" : "已开启公开赞助金额", "success");
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
        <span className="txt">公开赞助金额</span>
      </label>
      <span className="hint">开启后您的个人主页数据统计中将展示赞助金额</span>
    </div>
  );
}
