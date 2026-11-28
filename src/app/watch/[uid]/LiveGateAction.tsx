"use client";

// 旁观观看页·未关注引导态（2026-11-27 张老师定）：「XXX没有在练习」
// + 关注按钮（AvatarFollowBtn 真实关注状态）+ 引导文案——
// 未关注：「关注他，当他练习系统会自动通知你」
// 已关注（含刚点击关注的即时切换）：「他开始练习时，系统会自动通知你」
//
// AvatarFollowBtn 的按钮 click 有 stopPropagation（React 合成事件不出组件），
// 外层文案跟随态改用原生捕获监听（capture 阶段先于 React 合成处理）+ 按钮文本
// 轮询兜底（act() 成功后按钮文本变「✓已关注」）。

import { useEffect, useRef, useState } from "react";
import { AvatarFollowBtn } from "@/components/AvatarFollowBtn";

export function LiveGateAction({
  uid,
  sex,
  loggedIn,
}: {
  uid: number;
  sex: number;
  loggedIn: boolean;
}) {
  const [following, setFollowing] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const he = sex ? "他" : "她";

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    /* 捕获阶段监听按钮 click：立即翻转 UI（乐观）；失败由文本轮询纠正——
       act() 失败时按钮文本不变（仍「+关注他」），轮询 2 秒内校回 */
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element).closest("button");
      if (btn && !btn.disabled && loggedIn) setFollowing((v) => !v);
    };
    wrap.addEventListener("click", onClick, true);
    /* 文本轮询兜底：act() 完成后（成功/失败均已定型）按按钮真实文本校准 */
    pollRef.current = window.setInterval(() => {
      const btn = wrap.querySelector("button.fol_btn");
      if (!btn) return;
      const isFol = btn.classList.contains("is_fol");
      setFollowing(isFol);
    }, 800);
    return () => {
      wrap.removeEventListener("click", onClick, true);
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [loggedIn]);

  return (
    <div className="live_gate_action" ref={wrapRef}>
      <AvatarFollowBtn uid={uid} sex={sex} loggedIn={loggedIn} following={false} />
      <span className="live_gate_tip">
        {following ? `${he}开始练习时，系统会自动通知你` : `关注${he}，当${he}练习系统会自动通知你`}
      </span>
    </div>
  );
}
