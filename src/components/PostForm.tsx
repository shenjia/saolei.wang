// 发帖/编辑表单（共用）
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";

export function PostForm({
  postId,
  boards,
  initialBoard,
  initialTitle = "",
  initialContent = "",
}: {
  postId?: number;
  boards: [number, string][];
  initialBoard?: number;
  initialTitle?: string;
  initialContent?: string;
}) {
  const [board, setBoard] = useState(initialBoard ?? boards[0]?.[0] ?? 1);
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onSubmit() {
    setBusy(true);
    setError("");
    const body = postId
      ? { action: "edit", id: postId, title, content, board }
      : { action: "post", board, title, content };
    const res = await fetch("/api/bbs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "提交失败");
      return;
    }
    const data = await res.json();
    toast(postId ? "帖子已更新" : "发帖成功", "success");
    router.push(`/bbs/${postId ?? data.id}`);
  }

  return (
    <div className="post_form">
      <p>
        板块：
        <select value={board} onChange={(e) => setBoard(parseInt(e.target.value, 10))}>
          {boards.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </p>
      <p>
        <input
          type="text"
          placeholder="主题标题（100 字以内）"
          maxLength={100}
          style={{ width: "80%" }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </p>
      <p>
        <textarea
          rows={10}
          maxLength={5000}
          style={{ width: "90%" }}
          placeholder="支持 UBB：[b]粗体[/b] [url 地址]文字[/url] [img]图址[/img] [face]0[/face] [1]-[8][!][?] 扫雷符号"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </p>
      <p>
        <button className="button active" disabled={busy || !title.trim() || !content.trim()} onClick={onSubmit}>
          {postId ? "保存修改" : "发布主题"}
        </button>{" "}
        <span className="error">{error}</span>
      </p>
    </div>
  );
}
