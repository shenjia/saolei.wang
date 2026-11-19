// 每日一星「撰写当选感言」图标（2026-11-11 张老师定，替代原板块底部「发表感言」按钮）：
// 板块标题 h2 右上角，论坛「写文章」同款笔形 ICON。状态口径（张老师原话+弹窗说明语）：
//   默认亮灰，hover 绿；自己当日当选时常绿；编辑一次后变灰不可再点，除非被管理员移除
//   （预写制每人一份，普通用户写后即锁；**当日当选者有「再修改一次」窗口**——
//   未行使时常绿可改，行使后转灰）；删两次永久灰死。
// 点击弹 StarSpeechDialog（已写过且有当日改窗时预填原感言）；未登录点击弹全局登录浮窗。

"use client";

import { useState } from "react";
import { StarSpeechDialog } from "./StarSpeechDialog";

export function StarSpeechIcon({
  own,
  hasSpeech,
  blocked,
  canEditOnce,
  initialText,
  loggedIn,
}: {
  /** 观看者是否今日之星（当选且未行使当日修改时常绿） */
  own: boolean;
  /** 观看者已写过感言（user.star_speech 非空）——普通用户写后即锁 */
  hasSpeech: boolean;
  /** 观看者感言被删 ≥2 次——永久灰死 */
  blocked: boolean;
  /** 当选当日「再修改一次」窗口未行使（own 且 star.speechEdited=false） */
  canEditOnce: boolean;
  /** 原感言文本（有当日改窗时预填弹窗） */
  initialText?: string;
  loggedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  // 可写/可改 = 未封嘴 且（没写过 或 当选当日改窗未行使）
  const canEdit = !blocked && (!hasSpeech || canEditOnce);
  const off = !canEdit; // 灰死
  const on = loggedIn && own && canEdit; // 当日当选：常绿

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
      {open && (
        <StarSpeechDialog
          open={open}
          onClose={() => setOpen(false)}
          initialText={hasSpeech ? initialText : undefined}
        />
      )}
    </>
  );
}
