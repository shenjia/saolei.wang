// 路由变化自动滚回页面顶部（2026-09-24 张老师：顶部导航切换栏目应回到顶部）
// Chromium 上 Next App Router 自带滚顶，但 Safari 等浏览器软导航后不重置——此组件兜底。
// 后退/前进（popstate）不强制滚顶，交给浏览器/Next 恢复滚动位置；带 hash 的锚点跳转不干预。
// 2026-11-19 凌晨补充（张老师反馈「动态/录像翻页仍跳顶」根因）：翻页/搜索等**同页
// searchParams 变化**也会触发本组件——比赛详情页翻页被拍回顶部。同页（pathname
// 相同）仅参数变化时跳过滚顶：栏目切换是跨页导航（pathname 变），不靠这条路径。

"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function ScrollReset() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mounted = useRef(false);
  const popping = useRef(false);
  const prevPathname = useRef(pathname);

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
      prevPathname.current = pathname;
      return;
    }
    // 同页仅参数变化（翻页/筛选/搜索等软导航）不滚顶——页面还是那个页面，
    // 滚回顶部会打断阅读位置；跨页导航（pathname 变化）才回到顶部
    const samePage = prevPathname.current === pathname;
    prevPathname.current = pathname;
    if (!popping.current && !window.location.hash && !samePage) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    popping.current = false;
  }, [pathname, searchParams]);

  return null;
}
