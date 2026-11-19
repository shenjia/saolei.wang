// 「和他/她一决胜负」对战入口按钮（2026-11-09 张老师需求，文案 11-10 终版）：
// 仅用户主页性别图标 + 对话气泡右侧一处（2026-11-10 张老师要求：侧栏玩家卡片
// 的 VS 图标下线，比较只能在玩家主页发起）。
// 图标＝双人对撞爆炸（2026-11-10 张老师指定，复刻其 PNG）；默认灰度变暗（可用≈亮灰、
// 不可用≈暗灰），hover 恢复彩色 + 尺寸跳动一下——与对话气泡按钮同交互。
// 与 SendMessageButton 同族：未登录/看自己灰置 + data-tip 说明原因。
// 客户端组件（2026-11-11 张老师定打开方式：PC 新标签页，移动端本标签页——
// 关页面不便，PK 页内有返回按钮）：判端按全站铁律用 matchMedia（SSR 首帧
// 桌面形态 target=_blank，挂载后 ≤768 校准为当前标签页，无 hydration 差异）。

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/** 对战图标：VS 战斗字标（2026-11-10 张老师指定 pngtree versus battle 原图，4000×4000 透明底）。
 *  流程：alpha bbox 裁留白（2318×2466）→ LANCZOS 保比例缩至 96×102 落 public/icons/clash.png，
 *  20px 宽展示（hover 1.25 倍 / 2x retina 下仍清晰），灰度态由 CSS filter 控制。 */
export function ClashIcon() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 固定静态资源，无需 next/image 优化管线
    <img src="/icons/clash.png" alt="" width={96} height={102} draggable={false} />
  );
}

export function VsButton({
  to,
  viewerId,
  sex,
}: {
  /** 被挑战玩家 id */
  to: number;
  /** 当前登录用户 id（0=未登录：灰置；等于 to=看自己：灰置） */
  viewerId: number;
  /** 被挑战玩家性别（真值=男，假值=女；缺省回退「TA」）——2026-11-10 张老师要求气泡文案性别化 */
  sex?: number | boolean | null;
}) {
  const disabled = viewerId <= 0 || viewerId === to;
  // 移动端（≤768，与 VsScoreBoard/RecordsCurves 同断点）：当前标签页打开
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // 2026-11-10 张老师终版：hover 文案「和TA一决胜负」，其中 TA 按被挑战者性别
  // 换成「他/她」（user.sex 真值=男），性别缺失才回退字面 TA
  const pronoun = sex == null ? "TA" : sex ? "他" : "她";
  const tip =
    viewerId <= 0
      ? `登录后可和${pronoun}一决胜负`
      : viewerId === to
        ? "不能和自己一决胜负"
        : undefined;
  if (disabled) {
    return (
      <span
        className="vs_btn vs_btn--disabled"
        data-tip={tip}
        aria-label={`和${pronoun}一决胜负（不可用）`}
        aria-disabled={true}
      >
        <ClashIcon />
      </span>
    );
  }
  return (
    <Link
      className="vs_btn"
      // 五轮 13:38 张老师：链接带上自己 id（/vs/{自己id}/{对方id}）——
      // 落地竞技场双卡就位，URL 即本次对决的可分享形态
      href={`/vs/${viewerId}/${to}`}
      prefetch={false}
      // PC 新标签页 / 移动端本页（2026-11-11 张老师定）；target=_blank 必配 prefetch={false}
      target={isMobile ? undefined : "_blank"}
      rel={isMobile ? undefined : "noopener"}
      data-tip={`和${pronoun}一决胜负`}
      aria-label={`和${pronoun}一决胜负`}
    >
      <ClashIcon />
    </Link>
  );
}
