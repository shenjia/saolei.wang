// 头像 hover 关注按钮（2026-11-18 张老师需求 1）：悬停头像时在头像正下边缘浮现
// 按钮胶囊；已关注=亮灰「✓已关注」、hover 按钮变红「取消关注」、点击取关；
// 未关注=绿色「+关注他/她」、点击关注。登录态与初始已关注态由服务端 props 传入，
// 点击走 /api/follow（POST），成功后按钮就地切换状态（关注/取关动态已在服务端落库）。
//
// 用法：<AvatarFollowBtn uid={id} name={...} sex={1} loggedIn={...} following={...} />
// 容器 .ucd_left/.star_left/主页 .info 头像处由调用方包一层 position:relative 的
// .fol_wrap（本组件 absolute 定位 bottom:0 居中），hover 显隐由纯 CSS 完成。

"use client";

import { useState } from "react";
import { toast } from "./Toast";

export function AvatarFollowBtn({
  uid,
  sex,
  loggedIn,
  following,
}: {
  uid: number;
  /** 被关注人性别（按钮文案 关注他/她） */
  sex: number;
  /** 观看者已登录（未登录按钮点击弹提示，不渲染为隐藏——仍占 hover 位） */
  loggedIn: boolean;
  /** 观看者当前是否已关注该用户（服务端查出） */
  following: boolean;
}) {
  const [isFol, setIsFol] = useState(following);
  const [busy, setBusy] = useState(false);
  const [hoverBtn, setHoverBtn] = useState(false);

  async function act() {
    if (busy) return;
    if (!loggedIn) {
      toast("请先登录后再关注", "info");
      return;
    }
    setBusy(true);
    const next = !isFol;
    try {
      const res = await fetch("/api/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: next ? "follow" : "unfollow", uid }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast(data.error ?? "操作失败，请重试", "error");
        return;
      }
      setIsFol(next);
      toast(next ? "关注成功" : "已取消关注", "success");
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`fol_btn${isFol ? " is_fol" : ""}${hoverBtn && isFol ? " btn_hover" : ""}`}
      disabled={busy}
      onMouseEnter={() => setHoverBtn(true)}
      onMouseLeave={() => setHoverBtn(false)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void act();
      }}
    >
      {isFol ? (hoverBtn ? "取消关注" : "✓已关注") : sex ? "+关注他" : "+关注她"}
    </button>
  );
}
