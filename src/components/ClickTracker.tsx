"use client";

import { useEffect } from "react";

/**
 * 人气上报客户端组件（2026-11-09 张老师定：人气计数从服务端渲染剥离）
 * - 页面（用户主页 home / 用户卡片 card / 每日一星 star）挂载时异步上报一次
 * - sessionStorage 按页内标记防重复：React StrictMode 双执行、组件重挂载
 *   （弹层开关等）不重复计；真正的「同 IP 同日只计一次」闸门在服务端
 *   recordClick（click 表唯一键），这里只是省流量的第一道客户端去重
 * - 不带 JS 的爬虫（含攻击流量）不会执行本组件，天然不污染人气表
 * - 发送失败静默忽略（人气是尽力而为的统计，不值得重试）
 */
export default function ClickTracker({ userId, source }: { userId: number; source: "home" | "card" | "star" }) {
  useEffect(() => {
    if (!Number.isInteger(userId) || userId <= 0) return;
    // 页内去重键：同一页面会话内同目标同来源只报一次
    const key = `click-tracked:${source}:${userId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // 隐私模式等 sessionStorage 不可用：照常上报，服务端闸门兜底
    }
    fetch("/api/track/click", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ userId, source }),
      keepalive: true,
    }).catch(() => {});
  }, [userId, source]);
  return null;
}
