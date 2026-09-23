// BBS 客户端交互：回帖表单 + 管理操作条 + 删帖/删回复
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    router.refresh();
  }

  return (
    <div className="reply_form">
      <textarea
        rows={4}
        maxLength={5000}
        placeholder="支持 UBB：[b]粗体[/b] [url 地址]文字[/url] [img]图址[/img] [face]0[/face] [1]-[8][!][?] 扫雷符号"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <p>
        <button className="button active" disabled={busy || !content.trim()} onClick={onSubmit}>
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
  flags: { isTop: boolean; isNice: boolean; isLocked: boolean };
}) {
  const router = useRouter();
  const [error, setError] = useState("");

  async function op(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    const err = await callApi(body);
    if (err) {
      setError(err);
      return;
    }
    if (body.action === "delete") router.push("/bbs");
    else router.refresh();
  }

  return (
    <span className="bbs_ops">
      {isAdmin && (
        <>
          <a href="#" onClick={(e) => (e.preventDefault(), op({ action: "admin", id: postId, isTop: !flags.isTop }))}>
            {flags.isTop ? "取消置顶" : "置顶"}
          </a>{" "}
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
      {error && <span className="error"> {error}</span>}
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
        await callApi({ action: "delete_reply", id: replyId });
        router.refresh();
      }}
    >
      删除
    </a>
  );
}
