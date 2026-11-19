"use client";

// 首页邮箱绑定提醒浮层（2026-10-16 张老师要求改版）：
// 原 10-15 版是内容区顶部提醒条——不够明显且挤压页面布局 → 改为遮罩浮层，
// 只放提示文字 + 「马上绑定」/「以后再说」两个按钮；点「以后再说」写
// localStorage 时间戳，24 小时内不再弹出（绑定验证成功后服务端不再下发，自然消失）。
// 浮层由 page.tsx 渲染在 #page 之外（body 直下）：#page ≤605px 有整页 zoom，
// fixed 遮罩做在里面会随缩放失真铺不满屏（同 #gr_modal/#fs_tip 挂 body 直下的口径）。
// 遮罩复用 .login_overlay（fixed 9999 半透明黑），卡片复用登录浮窗暗玻璃视觉。

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";

const LS_KEY = "email_bind_dismiss_until"; // 值 = 免打扰截止时间戳（ms）
const DISMISS_MS = 24 * 3600 * 1000; // 「以后再说」= 24 小时

// storage 事件跨标签页同步（A 标签点以后再说，B 标签页浮层同步收起）
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

// localStorage 快照：不在免打扰期内 = 应显示（读不到/脏数据/隐私模式 → 显示）
function snapshot(): boolean {
  try {
    const until = Number(localStorage.getItem(LS_KEY));
    return !(until > Date.now());
  } catch {
    return true;
  }
}

export function EmailBindNotice() {
  // 水合期用 false（服务端不渲染浮层）→ 水合后切客户端快照：
  // 免打扰期内的用户不会先闪一帧浮层再消失
  const shouldShow = useSyncExternalStore(subscribeStorage, snapshot, () => false);
  // 本次浏览内已点「以后再说」（写 localStorage 后同页不会触发 storage 事件，需本地关）
  const [closed, setClosed] = useState(false);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, String(Date.now() + DISMISS_MS));
    } catch {
      /* 隐私模式写不进：仅本次关闭 */
    }
    setClosed(true);
  }, []);

  const visible = shouldShow && !closed;

  // 浮层显示时锁页面滚动（与登录浮窗同款）；不响应 ESC / 点遮罩——
  // 关闭入口只有两个按钮（张老师指定「只放提示文字和两个按钮」）
  useEffect(() => {
    if (!visible) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="login_overlay email_bind_overlay">
      <div className="email_bind_modal">
        <p className="text">
          您的账号尚未绑定邮箱
          <br />
          忘记密码时将<b>无法自助找回</b>
        </p>
        <div className="btns">
          <Link href="/account/email" className="btn_primary">
            马上绑定
          </Link>
          <button type="button" className="btn_later" onClick={dismiss}>
            以后再说
          </button>
        </div>
      </div>
    </div>
  );
}
