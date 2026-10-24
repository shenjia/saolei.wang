// BBS 客户端交互：回帖表单 + 管理操作条 + 删帖/删回复
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { RichEditor } from "./RichEditor";
import { useDraft, useHydrated } from "./useDraft";

async function callApi(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch("/api/bbs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error ?? "操作失败";
  }
  return null;
}

/** 回复表单（2026-10-13：新增 onPosted —— 详情页楼层流改为客户端「加载更多」后，
 *  整页刷新已不会自动追加新楼层，由楼层流组件就地接上）
 *  2026-10-15 评论回复（张老师要求）：quote 传入时编辑器画布顶部渲染不可编辑引用块
 *  （用户名 + 评论前50字超出省略，2026-10-15 二定：引用进输入框内，亮灰左粗框线+暗灰底），
 *  提交时带 replyTo=楼层 id，引用头由服务端拼装 */
export function ReplyForm({
  postId,
  locked,
  onPosted,
  quote,
  onQuoteCleared,
  authorId,
}: {
  postId: number;
  locked: boolean;
  onPosted?: () => void;
  /** 引用目标（楼层）：null = 普通回复 */
  quote: { replyId: number; authorName: string; excerpt: string } | null;
  onQuoteCleared?: () => void;
  /** 当前登录用户 id（草稿按作者隔离） */
  authorId: number;
}) {
  const [content, setContent] = useState("");
  // 草稿秒级备份：按作者 uid + 主题 id 隔离（同主题一份草稿，引用不备份——引用由点击「回复」重新触发）
  const draft = useDraft(`bbs-reply:${authorId}:${postId}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 提交成功后 +1 强制重挂编辑器（画布是非受控 contenteditable，setContent("") 清不掉
   *  DOM 内容；重挂即清空画布、placeholder 复现——引用态已由 onQuoteCleared 先清）。
   *  草稿恢复同样靠它：水合后合并到草稿正文即 +1 重挂载入 */
  const [formKey, setFormKey] = useState(0);
  const router = useRouter();
  // 空内容红气泡后自动定位到正文画布（2026-10-16 张老师要求）
  const editorAreaRef = useRef<HTMLDivElement>(null);

  // 水合后一次性合并草稿正文（渲染期调整 state——React 官方模式）：
  // 草稿 UBB 即序列化产物，直接入 state + 翻 key 重挂画布
  const hydrated = useHydrated();
  const [merged, setMerged] = useState(false);
  if (hydrated && !merged) {
    setMerged(true);
    if (draft.value) {
      setContent(draft.value);
      setFormKey((k) => k + 1);
    }
  }

  // 合并完成后内容变化即写盘（秒级备份）
  useEffect(() => {
    if (!merged) return;
    draft.set(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, content]);

  if (locked) return <p className="text">主题已锁定，无法回复。</p>;

  async function onSubmit() {
    // 空内容不再禁用按钮，点了给红色气泡；服务端错误（含敏感词前置过滤）同样气泡
    // （2026-10-16 张老师要求，与发帖表单同口径）
    if (!content.trim()) {
      toast("内容不能为空", "error");
      editorAreaRef.current?.querySelector<HTMLElement>(".wys")?.focus();
      return;
    }
    setBusy(true);
    setError("");
    const err = await callApi({
      action: "reply",
      id: postId,
      content,
      ...(quote ? { replyTo: quote.replyId } : {}),
    });
    setBusy(false);
    if (err) {
      setError(err);
      toast(err, "error");
      return;
    }
    draft.clear(); // 回复成功清空草稿
    setContent("");
    toast("回复发表成功", "success");
    onQuoteCleared?.();
    setFormKey((k) => k + 1); // 清空输入框（2026-10-16 张老师要求）
    onPosted?.();
    // 仍刷新一次服务端数据（主题抬升、评论计数、右栏等随之更新）
    router.refresh();
  }

  return (
    <div className="reply_form" ref={editorAreaRef}>
      <RichEditor
        key={formKey}
        initialContent={draft.value}
        minHeight={200}
        placeholder="直接输入回复内容"
        onChange={setContent}
        notify={toast}
        quote={
          quote
            ? {
                authorName: quote.authorName,
                excerpt: quote.excerpt,
                onRemove: onQuoteCleared,
              }
            : null
        }
      />
      <p className="submit_row">
        <button className="lp_submit_btn" disabled={busy} onClick={onSubmit}>
          回复
        </button>{" "}
        <span className="error">{error}</span>
      </p>
    </div>
  );
}

export function PostOps({
  postId,
  isOwner,
  isAdmin,
  flags,
}: {
  postId: number;
  isOwner: boolean;
  isAdmin: boolean;
  flags: { isPinned: boolean; isNice: boolean; isLocked: boolean };
}) {
  const router = useRouter();

  async function op(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !(await confirmDialog({ title: "删除主题", message: confirmText, danger: true, confirmText: "删除" }))) return;
    const err = await callApi(body);
    if (err) {
      toast(err, "error");
      return;
    }
    // 按操作给出对应的成功气泡（2026-09-24 张老师要求全站复用 toast）
    const label =
      body.action === "delete"
        ? "主题已删除"
        : body.isPinned !== undefined
          ? body.isPinned
            ? "已置顶"
            : "已取消置顶"
          : body.isNice !== undefined
            ? body.isNice
              ? "已加精"
              : "已取消精华"
            : body.isLocked !== undefined
              ? body.isLocked
                ? "已锁定"
                : "已解锁"
              : "操作成功";
    toast(label, "success");
    if (body.action === "delete") router.push("/bbs");
    else router.refresh();
  }

  return (
    <span className="bbs_ops">
      {isAdmin && (
        <>
          <a href="#" onClick={(e) => (e.preventDefault(), op({ action: "admin", id: postId, isPinned: !flags.isPinned }))}>
            {flags.isPinned ? "取消置顶" : "置顶"}
          </a>{" "}
          {/* 2026-10-23（张老师）：取消论坛高亮设定——「高亮」操作链接移除，
              isTop 不再可写（API 端同步忽略） */}
          <a href="#" onClick={(e) => (e.preventDefault(), op({ action: "admin", id: postId, isNice: !flags.isNice }))}>
            {flags.isNice ? "取消精华" : "加精"}
          </a>{" "}
          <a href="#" onClick={(e) => (e.preventDefault(), op({ action: "admin", id: postId, isLocked: !flags.isLocked }))}>
            {flags.isLocked ? "解锁" : "锁定"}
          </a>{" "}
        </>
      )}
      {(isOwner || isAdmin) && (
        <>
          <a href={`/bbs/edit/${postId}`}>编辑</a>{" "}
          <a
            href="#"
            onClick={(e) => (e.preventDefault(), op({ action: "delete", id: postId }, "确定删除该主题吗？"))}
          >
            删除
          </a>
        </>
      )}
    </span>
  );
}

/** 删楼层（详情页楼层流为客户端状态：传 onDeleted 时先就地摘除，再刷新服务端计数） */
export function ReplyDelete({ replyId, onDeleted }: { replyId: number; onDeleted?: () => void }) {
  const router = useRouter();
  return (
    <a
      href="#"
      onClick={async (e) => {
        e.preventDefault();
        if (!(await confirmDialog({ title: "删除回复", message: "确定删除该回复吗？", danger: true, confirmText: "删除" }))) return;
        const err = await callApi({ action: "delete_reply", id: replyId });
        if (err) {
          toast(err, "error");
          return;
        }
        toast("回复已删除", "success");
        onDeleted?.();
        router.refresh();
      }}
    >
      删除
    </a>
  );
}
