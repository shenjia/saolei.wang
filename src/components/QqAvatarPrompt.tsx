"use client";

// 绑定 QQ 后「要不要换成 QQ 头像」浮窗（2026-10-27 张老师要求）
//
// 触发：绑定成功且本人已有头像时，服务端把去向改成 ...?qqavatar=1，账户页据此挂载本组件。
// 形态：站内标准浮窗（Confirm），正文下方并排展示「当前头像 → QQ 头像」，
//      确认键「换成 QQ 头像」/ 取消键「保持原头像」。
// 确认：POST /api/account/avatar/qq —— QQ 头像落盘后进人工审核队列（不自动生效），
//      审核期间仍显示原头像；驳回也只是队列记录被标驳回，user.avatar 从未被改过。
// 无论确认还是取消，都把 URL 上的 qqavatar 参数抹掉，刷新不会重复问。

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";

interface Props {
  /** 当前对外展示的头像 URL */
  currentUrl: string;
  /** QQ 授权返回的头像外链（user_oauth.avatar） */
  qqUrl: string;
}

export function QqAvatarPrompt({ currentUrl, qqUrl }: Props) {
  const router = useRouter();
  const asked = useRef(false); // StrictMode 双挂载只问一次

  /** 抹掉 qqavatar=1 后的干净地址（router.replace 会整页 RSC 重取，state 保留不丢登录态） */
  function cleanedHref() {
    const url = new URL(window.location.href);
    url.searchParams.delete("qqavatar");
    const qs = url.searchParams.toString();
    return `${url.pathname}${qs ? `?${qs}` : ""}`;
  }

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;

    void (async () => {
      const ok = await confirmDialog({
        title: "要换成 QQ 头像吗？",
        message:
          "这个 QQ 账号带有一个头像。你当前账号已经有自己的照片，我们不会自动替换——想换就点下面的按钮，提交后需管理员审核，通过才会生效。",
        content: (
          <div className="qq_avatar_swap">
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={currentUrl} alt="当前头像" />
              <figcaption>当前头像</figcaption>
            </figure>
            <span className="qq_avatar_arrow" aria-hidden="true">
              <svg width="30" height="16" viewBox="0 0 30 16" fill="none">
                <path
                  d="M1 8h26m0 0-6.5-6M27 8l-6.5 6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qqUrl}
                alt="QQ 头像"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  // QQ 图床偶发防盗链：图裂时给个中性占位，别让浮窗看起来像坏了
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
              <figcaption>QQ 头像</figcaption>
            </figure>
          </div>
        ),
        confirmText: "换成 QQ 头像",
        cancelText: "保持原头像",
        wide: true,
      });

      // 取消 / 提交成功：抹掉标记，刷新不再问（提交失败则保留标记，用户刷新可再问一次）
      if (!ok) {
        router.replace(cleanedHref());
        return;
      }

      try {
        const res = await fetch("/api/account/avatar/qq", { method: "POST" });
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (!res.ok) {
          toast(data.error ?? "提交失败，请稍后重试", "error");
          return;
        }
        toast(data.message ?? "QQ 头像已提交审核", "success");
        router.replace(cleanedHref());
      } catch {
        toast("网络异常，请稍后重试", "error");
      }
    })();
  }, [currentUrl, qqUrl, router]);

  return null; // 纯触发器，不占页面布局
}
