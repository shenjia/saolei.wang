"use client";

// 更新历史登记表单（2026-11-02 后台「更新历史」页）
// 日期（date input，提交前归一为 Y.M.D 展示串）+ 内容 textarea，
// 提交走统一 /api/admin/action（siteupdate.add / siteupdate.edit）。
// 编辑模式：清单行「编辑」按钮派发 sl-siteupdate-edit 事件回填，可取消。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

interface EditingRow {
  id: number;
  date: string;
  content: string;
}

/** Y.M.D 展示串 → date input 用的 YYYY-MM-DD（补零） */
function toInputDate(d: string): string {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(d);
  if (!m) return d;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function SiteUpdateForm() {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditingRow | null>(null);

  // 监听清单行「编辑」：回填记录（日期转 YYYY-MM-DD 供 date input）
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as EditingRow;
      if (!d || typeof d.id !== "number") return;
      setEditing(d);
      setDate(toInputDate(d.date));
      setContent(d.content);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("sl-siteupdate-edit", onEdit);
    return () => window.removeEventListener("sl-siteupdate-edit", onEdit);
  }, []);

  const canSubmit = !busy && !!date.trim() && !!content.trim();

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing
            ? { op: "siteupdate.edit", id: editing.id, date, content }
            : { op: "siteupdate.add", date, content }
        ),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      toast(data.ok ? data.message ?? "已登记" : data.error ?? "登记失败", data.ok ? "success" : "error");
      if (data.ok) {
        setEditing(null);
        setContent("");
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
      className="donate_form"
      /* alignItems:stretch 压过 .donate_form 的 center——否则内容列收缩成 textarea 固有宽（~195px） */
      style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      {editing && (
        <div style={{ color: "#e6b422", fontSize: 13 }}>
          正在编辑更新历史 #{editing.id}（原 {editing.date}）{" "}
          <button
            type="button"
            className="admin_btn sm"
            onClick={() => {
              setEditing(null);
              setContent("");
            }}
          >
            取消编辑
          </button>
        </div>
      )}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "#939387" }}>
        日期
        <input
          className="admin_input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ width: 160 }}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start", fontSize: 13, color: "#939387" }}>
        更新内容
        <textarea
          className="admin_textarea"
          rows={6}
          maxLength={500}
          style={{ minHeight: 160 }}
          placeholder="一句话概括本次上线的功能（前台展示为「日期　内容」）"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <div>
        <button type="submit" className="admin_btn primary" disabled={!canSubmit}>
          {busy ? "提交中…" : editing ? "保存修改" : "登记更新"}
        </button>
        <span className="admin_hint" style={{ marginLeft: 10 }}>
          保存后前台 saolei.wang/page/history 立即生效
        </span>
      </div>
    </form>
  );
}
