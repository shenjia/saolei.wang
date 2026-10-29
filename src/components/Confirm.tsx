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
  /** 正文下方的自定义区块（不套 <p>，可放图片/并排对比等块级内容，2026-10-27） */
  content?: React.ReactNode;
  /** 加宽一档（420px）：并排展示图片等需要横向空间的浮窗用 */
  wide?: boolean;
  /** 确认键文案，默认「确定」 */
  confirmText?: string;
  /** 取消键文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作：确认键红色（legacy .button.danger） */
  danger?: boolean;
  /** 按钮组整体居中 + 确认键居左（2026-10-27 排名模式提示专用；默认右对齐取消居左） */
  centerActions?: boolean;
  /** 确认键下方附勾选框（2026-10-28 屏蔽录像用）：确认结果经 confirmDialogChecked 拿勾选态；
   *  用 confirmDialog（boolean 版）时勾选态被忽略 */
  checkbox?: {
    /** 勾选框说明（可用 <b> 强调） */
    label: React.ReactNode;
    /** 初始勾选态，默认不勾 */
    defaultChecked?: boolean;
  };
  /** 多勾选框版（2026-10-29 屏蔽录像弹窗：低信任分流 + 批量屏蔽未审录像两个勾选并存）；
   *  结果经 confirmDialogChecked 的 checks 按 key 取。与 checkbox 互斥，同时传时 checkboxes 优先 */
  checkboxes?: {
    key: string;
    label: React.ReactNode;
    defaultChecked?: boolean;
  }[];
};

/** confirmDialogChecked 的返回：ok=确认/取消；checked=单勾选框最终状态（旧字段，无勾选框恒 false）；
 *  checks=多勾选框按 key 的最终状态（2026-10-29） */
export type ConfirmCheckedResult = { ok: boolean; checked: boolean; checks: Record<string, boolean> };

type Pending = { options: ConfirmOptions; resolve: (r: ConfirmCheckedResult) => void };

let emit: ((options: ConfirmOptions) => Promise<ConfirmCheckedResult>) | null = null;

/** 命令式调用：任意客户端组件直接 `if (!(await confirmDialog(...))) return;` */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return confirmDialogChecked(options).then((r) => r.ok);
}

/** 带勾选框版（2026-10-28）：`const { ok, checked } = await confirmDialogChecked({...})` */
export function confirmDialogChecked(options: ConfirmOptions): Promise<ConfirmCheckedResult> {
  if (emit) return emit(options);
  // Host 尚未挂载：effect 是「子先父后」执行，页面组件在首帧调用时会早于 layout 里的
  // ConfirmHost 注册 emit（2026-10-27 绑定 QQ 头像浮窗实证：URL 参数被清掉但浮窗没弹）。
  // 这里轮询等待 ~300ms，仍无 Host 才按取消处理，绝不误执行。
  return new Promise<ConfirmCheckedResult>((resolve) => {
    let tries = 0;
    const tick = () => {
      if (emit) return resolve(emit(options));
      if (++tries > 10) return resolve({ ok: false, checked: options.checkbox?.defaultChecked ?? false, checks: {} });
      setTimeout(tick, 30);
    };
    tick();
  });
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const current = queue[0];
  const confirmRef = useRef<HTMLButtonElement>(null);
  /** 当前弹窗各勾选框状态（key → 勾选态；无勾选框为 undefined；每条队列项打开时初始化，2026-10-28）
   *  2026-10-29 起改为 Record 以支持多勾选框（旧单勾选框内部归一化为 key=""） */
  const [checks, setChecks] = useState<Record<string, boolean> | undefined>(undefined);

  useEffect(() => {
    emit = (options) =>
      new Promise<ConfirmCheckedResult>((resolve) => {
        setQueue((q) => [...q, { options, resolve }]);
      });
    return () => {
      emit = null;
    };
  }, []);

  function finish(ok: boolean) {
    if (!current) return;
    current.resolve({
      ok,
      checked: checks?.[""] ?? current.options.checkbox?.defaultChecked ?? false,
      checks: checks ?? {},
    });
    setQueue((q) => q.slice(1));
    setChecks(undefined);
  }

  // 打开时锁页面滚动 + ESC 取消 + 确认键聚焦 + 勾选框初始化
  useEffect(() => {
    if (!current) return;
    if (current.options.checkboxes) {
      setChecks(Object.fromEntries(current.options.checkboxes.map((c) => [c.key, c.defaultChecked ?? false])));
    } else if (current.options.checkbox) {
      setChecks({ "": current.options.checkbox.defaultChecked ?? false });
    } else {
      setChecks(undefined);
    }
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
  /** 渲染用勾选框列表：checkboxes 优先，旧单 checkbox 归一化为 key="" */
  const boxes =
    o.checkboxes ??
    (o.checkbox ? [{ key: "", label: o.checkbox.label, defaultChecked: o.checkbox.defaultChecked }] : []);

  return (
    <div className="confirm_overlay" onClick={() => finish(false)}>
      <div
        className={`confirm_dialog${o.wide ? " wide" : ""}`}
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
        {o.content && <div className="confirm_content">{o.content}</div>}
        {boxes.map((c) => (
          <label key={c.key} className="ban_check confirm_check">
            <input
              type="checkbox"
              checked={checks?.[c.key] ?? false}
              onChange={(e) => setChecks((prev) => ({ ...(prev ?? {}), [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
          </label>
        ))}
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

// -----------
// 全站图片灯箱（2026-10-27 张老师要求）：论坛正文图片渲染为 100x100 内小图（.ubb_img），
// 点击弹出大图查看。事件委托方案——文档级监听 click，命中 img.ubb_img 即弹层；
// 服务端渲染的 dangerouslySetInnerHTML 内容（bbs_content 等）无法逐图绑 React 事件，
// 委托是最小改动路径。不局限 .bbs_content：admin 待审列表等同类 img 一并覆盖。
// 挂载：layout 挂一次 <ImageLightboxHost />（同 ConfirmHost 模式）。

export function ImageLightboxHost() {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (!(t instanceof HTMLImageElement)) return;
      // 只响应带 ubb_img 类的图（[img] 标签产物）；表情/雷图/头像等正常图片不拦
      if (!t.classList.contains("ubb_img")) return;
      if (!t.src) return;
      e.preventDefault();
      setSrc(t.src);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSrc(null);
    }
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // 打开时锁页面滚动（同 ConfirmHost 口径）
  useEffect(() => {
    document.body.style.overflow = src ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [src]);

  if (!src) return null;

  return (
    <div className="lightbox_overlay" onClick={() => setSrc(null)}>
      {/* 大图本体：点击遮罩/ESC/× 关闭；点图不关闭（可仔细查看） */}
      <img className="lightbox_img" src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <a
        className="login_close lightbox_close"
        href="#"
        aria-label="关闭"
        onClick={(e) => (e.preventDefault(), setSrc(null))}
      >
        ×
      </a>
    </div>
  );
}
