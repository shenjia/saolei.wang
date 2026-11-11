"use client";

// 导航「对决」新功能绿字（2026-11-12 00:00 张老师改版）：
// · 没访问过对决页的登录用户：导航「对决」默认显示 active 绿（#a6e22e，同 hover 绿）
// · 鼠标 hover 一次即计入 localStorage，之后不再变绿
//   （移动端无 hover：点「对决」进对决页时计入，口径一致）
// · 2026-11-19 00:00（上线满一周）硬截止：到期后即使从未 hover 过也不再显示
//   —— 到期后本功能整体下线，请连同本文件与 globals.css 中 .vs_new_* 规则一并删除
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const DISMISS_KEY = "vs_new_hint_dismissed";
// 绿字硬截止：2026-11-11 上线，一周后（北京时间 2026-11-19 00:00）整体下线
const SHOW_UNTIL = Date.parse("2026-11-19T00:00:00+08:00");

function shouldShow(): boolean {
  if (Date.now() >= SHOW_UNTIL) return false;
  try {
    return localStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return false; // 隐私模式读不到就当已看过，宁缺毋滥
  }
}

/** hover / 点击「对决」时调用：计入 dismissed（跨会话永久） */
function persistDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore：写不进去只是下次再看一眼 */
  }
}

/** 未看过态（true=绿字）。SSR 首帧 false（点过的用户不闪绿），挂载后按 localStorage
 *  校准（同 PendingCounts 客户端校准模式）；共享 layout 软导航切页不重挂载——
 *  渲染期对比 pathname，切页时重校准。
 *  返回 [show, dismiss]：dismiss = 写 storage + 当场熄绿（无需等切页重校准） */
export function useVsNewHint(): [boolean, () => void] {
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
  const dismiss = useCallback(() => {
    persistDismiss();
    setShow(false);
  }, []);
  return [show, dismiss];
}

/** 桌面导航「对决」入口（layout.tsx 是 RSC，事件 handler 不能作 prop 传入，
 *  整链封装成本 client 组件）：未看过时挂 .vs_new_hint（绿字）；
 *  onMouseEnter 即计入并当场熄绿——hover 一次后鼠标移开即回普通灰，
 *  hover 伪类绿与绿字同色，过程中零跳变 */
export function VsNavLink() {
  const [show, dismiss] = useVsNewHint();
  return (
    <Link
      prefetch={false}
      href="/vs"
      className={show ? "vs_new_hint" : undefined}
      onMouseEnter={show ? dismiss : undefined}
    >
      对决
    </Link>
  );
}
