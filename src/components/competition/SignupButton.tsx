// 比赛报名按钮（客户端，2026-11-13 五轮 20:13 张老师定三态口径）：
// · 未报名：默认亮灰「报名中」，hover 切绿色「报名参赛」（尺寸不变），点击调 POST join；
// · 已报名：显示暗绿「已报名」，hover 换玫瑰红「退赛」，点击弹标准确认窗（confirmDialog），
//   确认后调 DELETE join，成功回到「报名中」态（router.refresh）；
// · 未登录：点击弹全局登录浮窗（LoginModal 监听 app:login，与感言赞/踩同口径）——
//   2026-11-13 五轮定「弹出登录窗口」，替代旧的跳登录页链接。
// 列表页 / 详情页共用本组件（detail 传参同口径）。

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { confirmDialog } from "@/components/Confirm";

export function SignupButton({
  compId,
  joined,
  name,
  loggedIn,
}: {
  compId: string;
  joined: boolean;
  name: string; // 确认窗文案用（比赛全名）
  /** 未登录时点击弹登录浮窗（CompBlock 统一传入，不再渲染跳登录页链接） */
  loggedIn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    try {
      const res = await fetch("/api/competition/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: compId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        toast(`已报名「${name}」`, "success");
        startTransition(() => router.refresh());
      } else {
        toast(data.error ?? "报名失败，请重试", "error");
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      const res = await fetch("/api/competition/join", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: compId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        toast(`已退出「${name}」报名`, "success");
        startTransition(() => router.refresh()); // 重渲染为未报名态（显示「报名中」）
      } else {
        toast(data.error ?? "退赛失败，请重试", "error");
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <button
        type="button"
        className="comp_btn comp_btn_joined comp_btn_leave"
        disabled={busy || pending}
        onClick={async () => {
          if (
            await confirmDialog({
              title: "退赛",
              message: `确定退出「${name}」的报名吗？`,
            })
          ) {
            leave();
          }
        }}
      >
        <span className="lbl_a">已报名</span>
        <span className="lbl_b">退赛</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="comp_btn comp_btn_signup"
      disabled={busy || pending}
      onClick={() => {
        if (!loggedIn) {
          // 未登录：弹全局登录浮窗（LoginModal 监听 app:login）
          window.dispatchEvent(new CustomEvent("app:login"));
          return;
        }
        join();
      }}
    >
      <span className="lbl_a">报名中</span>
      <span className="lbl_b">报名参赛</span>
    </button>
  );
}
