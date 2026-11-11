"use client";

// 导航「对决」新功能绿点（2026-11-11 23:03 张老师需求）：
// · 「对决」文字右上角放绿色小圆点，提示新功能上线
// · 用户点过「对决」后永久消失（localStorage 记忆，跨会话）
// · 2026-11-19 00:00（上线满一周）硬截止：到期后即使从未点过也不再显示
//   —— 到期后本功能整体下线，请连同本文件与 globals.css 中 .vs_new_* 规则一并删除
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const DISMISS_KEY = "vs_new_dot_dismissed";
// 绿点硬截止：2026-11-11 上线，一周后（北京时间 2026-11-19 00:00）整体下线
const SHOW_UNTIL = Date.parse("2026-11-19T00:00:00+08:00");

function shouldShow(): boolean {
  if (Date.now() >= SHOW_UNTIL) return false;
  try {
    return localStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return false; // 隐私模式读不到就当已看过，宁缺毋滥
  }
}

/** 点击「对决」导航时调用：记忆 dismissed，绿点永久消失 */
export function dismissVsNewDot() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore：写不进去只是下次再看一眼 */
  }
}

/** 绿点本体。SSR 首帧不渲染（避免点过的用户闪绿点），挂载后按 localStorage 校准
 *  （同 PendingCounts 客户端校准模式）。共享 layout 软导航切页不重挂载——
 *  渲染期对比 pathname，从 /vs 返回时重新校准（已点过即消失）。 */
export function VsNewDot() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setShow(shouldShow());
  }
  useEffect(() => {
    setShow(shouldShow());
  }, []);
  if (!show) return null;
  return <span className="vs_new_dot" aria-hidden="true" />;
}

/** 桌面导航「对决」入口：layout.tsx 是 RSC，onClick 不能作 prop 传入，
 *  整链（Link + 绿点 + 点击记忆）封装成本 client 组件 */
export function VsNavLink() {
  return (
    <Link prefetch={false} href="/vs" className="vs_new_anchor" onClick={dismissVsNewDot}>
      对决
      <VsNewDot />
    </Link>
  );
}
