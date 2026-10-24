// 每日一星「发表感言」按钮（九轮 2026-10-25）：本人登录态、板块底部；
// 论坛「写文章」同款 button active small 样式 + 笔形前置 ICON，点击弹感言浮窗。

"use client";

import { useState } from "react";
import { StarSpeechDialog } from "./StarSpeechDialog";

export function StarSpeechBar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button active small star_speech_btn" onClick={() => setOpen(true)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ verticalAlign: "-2px", marginRight: 4 }}
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        发表感言
      </button>
      {open && <StarSpeechDialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
