"use client";

// 支出登记表单（2026-10-30 收支管理）
// 用途 + 金额（元）+ 凭据图（可选）：选图即传 /api/admin/expense-evidence 拿 URL，
// 提交时连同 URL 走 expense.add。无凭据也可提交（evidence 空串）。

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

export function ExpenseForm() {
  const router = useRouter();
  // 登记日期（2026-10-30 张老师）：默认今天，可回填历史支出；sv-SE locale 输出 YYYY-MM-DD
  const today = new Date().toLocaleDateString("sv-SE");
  const [purpose, setPurpose] = useState("");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState(""); // 上传成功后的 URL；空=未上传
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pickFile = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      toast("图片超过 8MB 上限", "error");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/expense-evidence", { method: "POST", body: form });
      const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (data.ok && data.url) {
        setEvidence(data.url);
        toast("凭据已上传", "success");
      } else {
        toast(data.error ?? "上传失败", "error");
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const canSubmit = !busy && !uploading && !!purpose.trim() && !!amount.trim();

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "expense.add", purpose: purpose.trim(), date, amount: amount.trim(), evidence }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      toast(data.ok ? data.message ?? "已登记" : data.error ?? "登记失败", data.ok ? "success" : "error");
      if (data.ok) {
        // 日期保留不重置（2026-10-30 张老师）：方便连续录入同一日的多笔账单
        setPurpose("");
        setAmount("");
        setEvidence("");
        router.refresh();
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="donate_form expense_form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <label className="expense_purpose">
        用途
        <input
          className="admin_input"
          type="text"
          placeholder="如：10月服务器续费"
          maxLength={100}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          style={{ width: 180 }}
        />
      </label>
      <label>
        金额（元）
        <input
          className="admin_input"
          type="text"
          inputMode="decimal"
          placeholder="如 299 或 88.5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ width: 110 }}
        />
      </label>
      <label>
        日期
        <input
          className="admin_input"
          type="date"
          max={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ width: 150 }}
        />
      </label>
      <label>
        凭据
        <input
          ref={fileRef}
          className="admin_input expense_file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
          }}
          style={{ width: 200 }}
        />
      </label>
      <button type="submit" className="admin_btn primary" disabled={!canSubmit}>
        {busy ? "提交中…" : "登记支出"}
      </button>

      <div className="donate_lookup">
        {uploading && <span className="sub">凭据上传中…</span>}
        {!uploading && evidence && (
          <span>
            <span className="admin_tag ok">已上传</span>{" "}
            <a className="link" href={evidence} target="_blank" rel="noopener noreferrer">
              {evidence}
            </a>
          </span>
        )}
        {!uploading && !evidence && <span className="sub">凭据可选；支持 JPG / PNG / WebP，8MB 以内</span>}
      </div>
    </form>
  );
}
