// 首页「今日练习」板块（2026-10-22 张老师要求）：「开始练习」按钮下方、审核提醒行上方。
// 文案「今日已练习 xxx/yyy 局」（xxx=我的局数，绿色；yyy=全站局数）+
// 灰色小字「xx位雷友参与」；下缘 30 天走势迷你折线铺满整个模块宽度。
// 桌面侧栏与移动端置顶按钮各渲染一份（id 前缀区分，隐区由 CSS 断点控制）。
// 「我的局数」双轨（2026-10-22 二轮张老师要求）：
// · 登录态＝服务端 practice_log 按 uid 计数（SSR 直出，信任服务端）；
// · 未登录＝localStorage 当日记数（practice-local.ts，OnlinePlay 终态局 +1）——
//   SSR 初值 0，水合后 useSyncExternalStore 订阅补真值（跨 tab 实时同步，
//   无水合不匹配；storage 事件触发重读，练完一局回首页刷新即见）。
// 2026-10-22 三轮（张老师要求）：板块移到「开始练习」按钮**下方**；主行文字改站内标准亮灰
// #b1b1a4（与数据统计盒数值同色，2026-09-27 口径），仅「我的局数」保持绿色。

"use client";

import { useSyncExternalStore } from "react";
import { getLocalPractice, practiceLocalKey } from "@/lib/practice-local";

const GREEN = "#a6e22e"; // 站内标准绿（.logo a h1 hover / Sparkline 默认色）

/** 零依赖迷你折线（后台 admin/Charts Sparkline 同款算法） */
function Line({ values, color, height }: { values: number[]; color: string; height: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1); // viewBox 横向铺满 0-100
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(height - (v / max) * (height - 3) - 1.5).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.85" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 订阅 localStorage「今日练习」记数的变更（同窗口立即通知 + 跨 tab storage 事件） */
const subscribePractice = (cb: () => void): (() => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(practiceLocalKey, cb); // OnlinePlay bumpLocalPractice 后派发
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(practiceLocalKey, cb);
  };
};

export function PracticeToday({
  prefix,
  mine,
  total,
  users,
  trend,
  logged,
}: {
  /** DOM id 前缀：桌面侧栏 "practice_today" / 移动端 "practice_today_top" */
  prefix: string;
  /** 服务端口径的「我的局数」：登录=practice_log 当日 uid 计数；未登录恒 0 */
  mine: number;
  total: number;
  users: number;
  trend: number[];
  /** 登录态：true=信任服务端 mine；false=读 localStorage */
  logged: boolean;
}) {
  const localMine = useSyncExternalStore(
    subscribePractice,
    () => (logged ? mine : getLocalPractice()),
    () => mine // SSR 快照：登录=真值、未登录=0（水合后由 getSnapshot 接管补真值）
  );
  return (
    <div id={prefix} className="practice_today">
      <p className="pt_line">
        今日已练习{" "}
        <b className="mine">{localMine}</b>
        <span className="sep">/</span>
        <b className="total">{total.toLocaleString("zh-CN")}</b> 局
      </p>
      <p className="pt_sub">共{users}位雷友参与</p>
      <div className="pt_chart">
        <Line values={trend} color={GREEN} height={38} />
      </div>
    </div>
  );
}
