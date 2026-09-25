// 发帖/编辑表单（共用）
// 2026-09-25 张老师确认改版：所见即所得编辑器（RichEditor，存储仍是 UBB）；
// 板块分类 = 下划线筛选器紧挨标题右侧（站内 .tabs 同款），默认杂谈；
// 排序分身份：管理员=公告/技术/杂谈/问答，普通用户=杂谈/技术/问答（公告不显示）；
// 提交按钮 = 登录弹窗 .lp_submit 同款黄色按钮，居中。

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";
import { RichEditor } from "./RichEditor";

export function PostForm({
  postId,
  boards,
  initialBoard,
  initialTitle = "",
  initialContent = "",
  isAdmin = false,
}: {
  postId?: number;
  boards: [number, string][];
  initialBoard?: number;
  initialTitle?: string;
  initialContent?: string;
  /** 管理员：公告排第一；普通用户：杂谈第一且公告不显示 */
  isAdmin?: boolean;
}) {
  // 展示顺序：管理员=公告在前，普通用户=杂谈在前（公告隐藏）；不在列表里的（如历史板块）追加在尾
  const order = isAdmin ? [0, 1, 2, 3] : [2, 1, 3];
  const sorted = [
    ...order.filter((id) => boards.some((b) => b[0] === id)).map((id) => boards.find((b) => b[0] === id)!),
    ...boards.filter((b) => !order.includes(b[0])),
  ];
  const [board, setBoard] = useState(
    initialBoard !== undefined && sorted.some((b) => b[0] === initialBoard)
      ? initialBoard
      : sorted[0]?.[0] ?? 1
  );
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
      <div className="post_head">
        <h1>{postId ? "编辑主题" : "发布主题"}</h1>
        <div className="board_tabs">
          {sorted.map(([id, name]) => (
            <button
              key={id}
              type="button"
              className={`board_tab${board === id ? " on" : ""}`}
              onClick={() => setBoard(id)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <p className="frow">
        <input
          type="text"
          placeholder="主题标题（100 字以内）"
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </p>
      <RichEditor
        initialContent={initialContent}
        minHeight={300}
        placeholder="直接输入正文，工具栏可插入表情与雷图"
        onChange={setContent}
        notify={toast}
      />
      <p className="submit_row">
        <button className="lp_submit_btn" disabled={busy || !title.trim() || !content.trim()} onClick={onSubmit}>
          {postId ? "保存修改" : "发布主题"}
        </button>{" "}
        <Link className="btn_back" href="/bbs">返回</Link>{" "}
        <span className="error">{error}</span>
      </p>
    </div>
  );
}
