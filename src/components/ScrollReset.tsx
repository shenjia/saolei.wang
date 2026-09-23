// 路由变化自动滚回页面顶部（2026-09-24 张老师：顶部导航切换栏目应回到顶部）
// Chromium 上 Next App Router 自带滚顶，但 Safari 等浏览器软导航后不重置——此组件兜底。
// 后退/前进（popstate）不强制滚顶，交给浏览器/Next 恢复滚动位置；带 hash 的锚点跳转不干预。

"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function ScrollReset() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mounted = useRef(false);
  const popping = useRef(false);

  useEffect(() => {
    const onPop = () => {
      popping.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    // 首次挂载不滚（避免覆盖浏览器刷新时的滚动恢复）
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!popping.current && !window.location.hash) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    popping.current = false;
  }, [pathname, searchParams]);

  return null;
}
