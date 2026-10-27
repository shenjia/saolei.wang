"use client";

// 通用确认浮窗（2026-10-24 张老师要求）：替换前台所有 window.confirm 系统模态框。
// 视觉与登录浮窗 / 纪事浮窗同款（遮罩 + 暗玻璃面板，样式见 globals.css .confirm_overlay）。
// 用法：
//   const ok = await confirmDialog({ title: "清空消息", message: "确定清空所有消息吗？" });
//   可选 confirmText / cancelText / danger（危险操作确认键红字）/ message 可传 JSX（<em> 标红）。
// 返回 Promise<boolean>：确定 = true；取消（按钮 / ESC / 点遮罩 / ×）= false。
// 挂载：layout 挂一次 <ConfirmHost />（同 ToastHost 模式，全站可用）。
// 交互：打开锁页面滚动；确认键自动聚焦（回车即确认）；多个确认请求按队列串行弹出。

import { useEffect, useRef, useState } from "react";

export type ConfirmOptions = {
  /** 浮窗标题（如「清空消息」「删除录像」） */
  title: string;
  /** 正文；传字符串时按 pre-line 折行，可传 JSX（<em> 关键字标红） */
  message: React.ReactNode;
  /** 确认键文案，默认「确定」 */
  confirmText?: string;
  /** 取消键文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作：确认键红色（legacy .button.danger） */
  danger?: boolean;
  /** 按钮组整体居中 + 确认键居左（2026-10-27 排名模式提示专用；默认右对齐取消居左） */
  centerActions?: boolean;
};

type Pending = { options: ConfirmOptions; resolve: (ok: boolean) => void };

let emit: ((options: ConfirmOptions) => Promise<boolean>) | null = null;

/** 命令式调用：任意客户端组件直接 `if (!(await confirmDialog(...))) return;` */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (emit) return emit(options);
  return Promise.resolve(false); // Host 未挂载（极端时序）按取消处理，绝不误执行
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const current = queue[0];
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    emit = (options) =>
      new Promise<boolean>((resolve) => {
        setQueue((q) => [...q, { options, resolve }]);
      });
    return () => {
      emit = null;
    };
  }, []);

  function finish(ok: boolean) {
    if (!current) return;
    current.resolve(ok);
    setQueue((q) => q.slice(1));
  }

  // 打开时锁页面滚动 + ESC 取消 + 确认键聚焦
  useEffect(() => {
    if (!current) return;
    document.body.style.overflow = "hidden";
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!current) return null;
  const o = current.options;

  return (
    <div className="confirm_overlay" onClick={() => finish(false)}>
      <div
        className="confirm_dialog"
        role="dialog"
        aria-modal="true"
        aria-label={o.title}
        onClick={(e) => e.stopPropagation()}
      >
        <a
          className="login_close"
          href="#"
          aria-label="关闭"
          onClick={(e) => (e.preventDefault(), finish(false))}
        >
          ×
        </a>
        <h1>{o.title}</h1>
        <p className="confirm_desc">{o.message}</p>
        <div className={`confirm_ops${o.centerActions ? " centered" : ""}`}>
          <button type="button" className="button small" onClick={() => finish(false)}>
            {o.cancelText ?? "取消"}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`button small ${o.danger ? "danger" : "active"}`}
            onClick={() => finish(true)}
          >
            {o.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
