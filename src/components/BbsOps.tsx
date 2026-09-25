// BBS 客户端交互：回帖表单 + 管理操作条 + 删帖/删回复
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toast";
import { RichEditor } from "./RichEditor";

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

export function ReplyForm({ postId, locked }: { postId: number; locked: boolean }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (locked) return <p className="text">主题已锁定，无法回复。</p>;

  async function onSubmit() {
    setBusy(true);
    setError("");
    const err = await callApi({ action: "reply", id: postId, content });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setContent("");
    toast("回复发表成功", "success");
    router.refresh();
  }

  return (
    <div className="reply_form">
      <RichEditor
        initialContent=""
        minHeight={200}
        placeholder="直接输入回复内容"
        onChange={setContent}
        notify={toast}
      />
      <p className="submit_row">
        <button className="lp_submit_btn" disabled={busy || !content.trim()} onClick={onSubmit}>
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
  notice,
  flags,
}: {
  postId: number;
  isOwner: boolean;
  isAdmin: boolean;
  /** notice=true 时隐藏「高亮」——公告板块一律强制高亮（2026-09-25），无需也不可手动切换 */
  notice?: boolean;
  flags: { isTop: boolean; isPinned: boolean; isNice: boolean; isLocked: boolean };
}) {
  const router = useRouter();

  async function op(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
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
          : body.isTop !== undefined
            ? body.isTop
              ? "已高亮"
              : "已取消高亮"
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
          {!notice && (
            <>
              <a href="#" onClick={(e) => (e.preventDefault(), op({ action: "admin", id: postId, isTop: !flags.isTop }))}>
                {flags.isTop ? "取消高亮" : "高亮"}
              </a>{" "}
            </>
          )}
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

export function ReplyDelete({ replyId }: { replyId: number }) {
  const router = useRouter();
  return (
    <a
      href="#"
      onClick={async (e) => {
        e.preventDefault();
        if (!confirm("确定删除该回复吗？")) return;
        const err = await callApi({ action: "delete_reply", id: replyId });
        if (err) {
          toast(err, "error");
          return;
        }
        toast("回复已删除", "success");
        router.refresh();
      }}
    >
      删除
    </a>
  );
}
