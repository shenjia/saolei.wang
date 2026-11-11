// 每日一星「撰写当选感言」图标（2026-11-11 张老师定，替代原板块底部「发表感言」按钮）：
// 板块标题 h2 右上角，论坛「写文章」同款笔形 ICON。状态口径（张老师原话）：
//   默认亮灰，hover 绿；自己当日当选时常绿；写过一次后变灰不可再点（预写制每人一份、
//   一次性），除非管理员移除（删除清空后解锁）；删两次永久灰死。
// 点击弹 StarSpeechDialog（原获奖者感言弹窗）；未登录点击弹全局登录浮窗。

"use client";

import { useState } from "react";
import { StarSpeechDialog } from "./StarSpeechDialog";

export function StarSpeechIcon({
  own,
  hasSpeech,
  blocked,
  loggedIn,
}: {
  /** 观看者是否今日之星（当选且未写过时常绿） */
  own: boolean;
  /** 观看者已写过感言（user.star_speech 非空）——灰死不可点 */
  hasSpeech: boolean;
  /** 观看者感言被删 ≥2 次——永久灰死 */
  blocked: boolean;
  loggedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const off = hasSpeech || blocked; // 已写过 / 封嘴：灰死
  const on = loggedIn && own && !off; // 当日当选且未写：常绿

  function click() {
    if (off) return;
    if (!loggedIn) {
      // 未登录：弹全局登录浮窗（LoginModal 监听 app:login，与感言赞/踩同口径）
      window.dispatchEvent(new CustomEvent("app:login"));
      return;
    }
    setOpen(true);
  }

  return (
    <>
      <span
        className={`star_write${on ? " on" : ""}${off ? " off" : ""}`}
        data-tip={blocked ? "感言已被删除两次，不能再撰写" : "撰写当选感言"}
        role="button"
        aria-disabled={off}
        onClick={click}
      >
        {/* 笔形 ICON：论坛「写文章」按钮同款（原 StarSpeechBar 前置图标） */}
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
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </span>
      {open && <StarSpeechDialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
