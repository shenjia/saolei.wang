// 发帖/编辑表单（共用）
// 2026-09-25 张老师确认改版：所见即所得编辑器（RichEditor，存储仍是 UBB）；
// 板块分类 = 下划线筛选器紧挨标题右侧（站内 .tabs 同款），默认杂谈；
// 排序分身份：管理员=公告/技术/杂谈/问答，普通用户=杂谈/技术/问答（公告不显示）；
// 提交按钮 = 登录弹窗 .lp_submit 同款黄色按钮，居中。
// 2026-10-16 张老师要求：空标题/空正文不再禁用按钮——点了弹红色气泡；
// 敏感词前置过滤未通过（服务端 400 文案）同样只弹红色气泡，
// 不再在「返回」按钮右侧重复一行红字。

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";
import { RichEditor } from "./RichEditor";
import { useDraft, useHydrated } from "./useDraft";

/** 帖子草稿结构：标题 + 板块 + 正文（UBB），一体存取 */
interface PostDraft {
  title: string;
  board: number;
  content: string;
}

export function PostForm({
  postId,
  boards,
  initialBoard,
  initialTitle = "",
  initialContent = "",
  isAdmin = false,
  authorId,
}: {
  postId?: number;
  boards: [number, string][];
  initialBoard?: number;
  initialTitle?: string;
  initialContent?: string;
  /** 管理员：公告排第一；普通用户：杂谈第一且公告不显示 */
  isAdmin?: boolean;
  /** 当前登录用户 id（草稿按作者隔离） */
  authorId: number;
}) {
  // 展示顺序：管理员=公告在前，普通用户=杂谈在前（公告隐藏）；不在列表里的（如历史板块）追加在尾
  const order = isAdmin ? [0, 1, 2, 3] : [2, 1, 3];
  const sorted = [
    ...order.filter((id) => boards.some((b) => b[0] === id)).map((id) => boards.find((b) => b[0] === id)!),
    ...boards.filter((b) => !order.includes(b[0])),
  ];
  // 草稿秒级备份：发帖按作者 uid、编辑帖按作者 uid + 帖子 id 隔离；标题/板块/正文一体存取
  const draft = useDraft(`bbs-post:${authorId}${postId ? `:${postId}` : ""}`);
  const [board, setBoard] = useState(
    initialBoard !== undefined && sorted.some((b) => b[0] === initialBoard)
      ? initialBoard
      : sorted[0]?.[0] ?? 1
  );
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // 空内容红气泡后自动定位（2026-10-16 张老师要求）：标题框 / 正文画布（.wys contenteditable）
  const titleRef = useRef<HTMLInputElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  // 草稿恢复：RichEditor 画布是非受控 contenteditable，靠 key 翻转重挂载入草稿正文
  const [editorKey, setEditorKey] = useState(0);

  // 水合后一次性合并草稿（渲染期调整 state——React 官方模式，无 effect 级联）：
  // 标题/板块/正文任一有存稿即整体还原；编辑页已保存正文优先，不被旧草稿覆盖
  const hydrated = useHydrated();
  const [merged, setMerged] = useState(false);
  if (hydrated && !merged) {
    setMerged(true);
    try {
      const p = JSON.parse(draft.value) as Partial<PostDraft>;
      if (typeof p?.title === "string" && p.title) setTitle(p.title);
      if (typeof p?.board === "number" && sorted.some((b) => b[0] === p.board)) setBoard(p.board);
      if (typeof p?.content === "string" && p.content && !initialContent) {
        setContent(p.content);
        setEditorKey((k) => k + 1);
      }
    } catch {
      /* 脏数据静默忽略 */
    }
  }

  // 合并完成后，任一字段变化即整体写盘（秒级备份）
  useEffect(() => {
    if (!merged) return;
    draft.set(JSON.stringify({ title, board, content }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, title, board, content]);

  async function onSubmit() {
    // 空标题/空正文不再禁用按钮，点了给红色气泡（2026-10-16 张老师要求）
    if (!title.trim()) {
      toast("标题不能为空", "error");
      titleRef.current?.focus();
      return;
    }
    if (!content.trim()) {
      toast("内容不能为空", "error");
      editorAreaRef.current?.querySelector<HTMLElement>(".wys")?.focus();
      return;
    }
    setBusy(true);
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
      // 敏感词等服务端拒绝只走红色气泡，不在「返回」旁再写一行
      toast(data.error ?? "提交失败", "error");
      return;
    }
    const data = await res.json();
    draft.clear(); // 发布/保存成功清空草稿
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
          ref={titleRef}
          type="text"
          placeholder="主题标题（100 字以内）"
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </p>
      <div ref={editorAreaRef}>
        <RichEditor
          key={editorKey}
          initialContent={content}
          minHeight={300}
          placeholder="直接输入正文，工具栏可插入表情与雷图"
          onChange={setContent}
          notify={toast}
        />
      </div>
      <p className="submit_row">
        <button className="lp_submit_btn" disabled={busy} onClick={onSubmit}>
          {postId ? "保存修改" : "发布主题"}
        </button>{" "}
        <Link className="btn_back" href="/bbs">返回</Link>
      </p>
    </div>
  );
}
