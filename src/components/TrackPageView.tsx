"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Suspense } from "react";

/**
 * 全站访问埋点（2026-10-16 挂 root layout，参考 01xue.com 同名组件）
 * - SPA 路由切换：pathname 变化触发上报（组件不重挂载，需手动 watch）
 * - useSearchParams 必须包 Suspense（否则 CSR bailout 影响整站 SSG）
 * - /admin 与 /api 前缀由后端 track API 拒绝，无需前端判断
 *
 * 流失诊断三件套（与 01xue 同语义）：
 * - clientId：每个页面实例生成一次，view 与 dwell 两条 beacon 的关联键
 *   （sendBeacon 读不到响应，拿不到后端自增 id，只能前端造键）
 * - dwellMs：前台可见停留时长（visibilitychange 累计，切后台不计）
 * - scrollPct：最大滚动深度 0-100（无滚动页面记 100）
 * - clicked：页面内是否有任意点击（pointerdown 捕获一次即标记）
 * - firstClickHref：首个点击目标的 href（仅 <a>，判别点击流向 CTA/录像卡/其他）
 * dwell 上报时机：visibilitychange→hidden、pagehide、SPA 路由切换（effect cleanup）；
 * 均为累计值多次上报，后端后写覆盖即可。
 */

function TrackPageViewInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin")) return;

    const beacon = (url: string, payload: string) => {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: "text/plain;charset=UTF-8" }));
      } else {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };

    // 页面实例 id（view 与 dwell 对同一条 PV 的关联键）
    const clientId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);

    beacon(
      "/api/track/view",
      JSON.stringify({
        path: pathname,
        referrer: typeof document !== "undefined" && document.referrer ? document.referrer.slice(0, 500) : null,
        clientId,
      })
    );

    // ---- 停留时长 / 滚动深度 / 交互追踪 ----
    let visibleMs = 0;
    let visibleSince = document.visibilityState === "visible" ? performance.now() : 0;
    let maxScroll = 0;
    let clicked = false;
    // 首个点击目标：向上找最近的 <a href>（pointerdown 捕获阶段，点击即生效，
    // 早于路由跳转）。只记第一次，后续上报重复携带同一值，后端后写覆盖不影响。
    let firstClickHref: string | null = null;

    const currentDwellMs = () =>
      visibleSince ? visibleMs + (performance.now() - visibleSince) : visibleMs;

    const measureScroll = () => {
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const pct = total <= 0 ? 100 : Math.min(100, Math.round((window.scrollY / total) * 100));
      if (pct > maxScroll) maxScroll = pct;
    };
    measureScroll(); // 首屏即算一次（一屏放完的页面记 100%）

    const sendDwell = () => {
      beacon(
        "/api/track/dwell",
        JSON.stringify({
          clientId,
          dwellMs: Math.round(currentDwellMs()),
          scrollPct: maxScroll,
          clicked,
          firstClickHref,
        })
      );
    };

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        measureScroll();
      }, 150);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (visibleSince) {
          visibleMs += performance.now() - visibleSince;
          visibleSince = 0;
        }
        sendDwell();
      } else if (document.visibilityState === "visible" && !visibleSince) {
        visibleSince = performance.now();
      }
    };

    const onClick = (e: PointerEvent) => {
      clicked = true;
      if (firstClickHref === null) {
        const a = (e.target as Element | null)?.closest?.("a[href]");
        const href = a?.getAttribute("href");
        if (href) firstClickHref = href.slice(0, 255);
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", onClick, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", sendDwell);

    return () => {
      // SPA 路由切换 = 当前页浏览结束，补一次最终 dwell（累计值，后端后写覆盖）
      if (scrollTimer) clearTimeout(scrollTimer);
      sendDwell();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", sendDwell);
    };
    // searchParams 仅用于触发（列表页筛选算同 path，后端 10s 去重）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  return null;
}

export default function TrackPageView() {
  return (
    <Suspense fallback={null}>
      <TrackPageViewInner />
    </Suspense>
  );
}
