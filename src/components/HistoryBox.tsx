// 扫雷历程区块（移植 2008 版 History_List + Add/Edit）：本人可增删改
// 2026-09-23 张老师要求：初始最多显示 15 条，底部「加载更多」
"use client";

import { useState } from "react";
import { USER_HISTORY_NUMBER } from "@/lib/config";
import { totalLabel } from "@/lib/format";
import type { HistoryItem } from "@/lib/history";
import { noFocusJump } from "./useKeepScroll";

export function HistoryBox({
  userId,
  items: initial,
  editable,
}: {
  userId: number;
  items: HistoryItem[];
  editable: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [visible, setVisible] = useState(USER_HISTORY_NUMBER);
  const [month, setMonth] = useState("");
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "操作失败");
      return false;
    }
    return true;
  }

  async function onAdd() {
    if (!(await call({ action: "add", month, content }))) return;
    const item = { id: Date.now(), month, content: content.trim() };
    setItems((list) => [item, ...list].sort((a, b) => (a.month < b.month ? 1 : -1)));
    setMonth("");
    setContent("");
  }

  async function onUpdate(id: number) {
    if (!(await call({ action: "update", id, content: editingContent }))) return;
    setItems((list) => list.map((it) => (it.id === id ? { ...it, content: editingContent.trim() } : it)));
    setEditingId(null);
  }

  async function onDelete(id: number) {
    if (!confirm("确定删除这条历程吗？")) return;
    if (!(await call({ action: "delete", id }))) return;
    setItems((list) => list.filter((it) => it.id !== id));
  }

  return (
    <div className="box" id="history">
      <h2>扫雷历程</h2>
      {items.length === 0 && <p className="text">还没有记录。</p>}
      {items.slice(0, visible).map((it) => (
        <div key={it.id} className="history_item">
          <em>{it.month}</em>{" "}
          {editingId === it.id ? (
            <>
              <textarea
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                rows={2}
                maxLength={500}
              />
              <button className="button active" disabled={busy} onClick={() => onUpdate(it.id)}>
                保存
              </button>{" "}
              <button className="button" onClick={() => setEditingId(null)}>
                取消
              </button>
            </>
          ) : (
            <>
              <span>{it.content}</span>
              {editable && (
                <span className="ops">
                  {" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setEditingId(it.id);
                      setEditingContent(it.content);
                    }}
                  >
                    编辑
                  </a>{" "}
                  <a href="#" onClick={(e) => (e.preventDefault(), onDelete(it.id))}>
                    删除
                  </a>
                </span>
              )}
            </>
          )}
        </div>
      ))}
      {items.length > visible && (
        <div className="more_loader">
          <button
            type="button"
            className="button small"
            onMouseDown={noFocusJump}
            onClick={() => setVisible((n) => n + USER_HISTORY_NUMBER)}
          >
            加载更多
          </button>
          <span className="total_count">{totalLabel(items.length)}</span>
        </div>
      )}
      {editable && (
        <div className="history_add">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ width: 140 }}
          />{" "}
          <input
            type="text"
            placeholder="这个月有什么值得记录的？"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={500}
            style={{ width: "60%" }}
          />{" "}
          <button className="button active" disabled={busy || !month || !content.trim()} onClick={onAdd}>
            添加
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <input type="hidden" value={userId} readOnly />
    </div>
  );
}
