// NF 筛选开关（2026-10-20 张老师需求）：录像列表的 NF 过滤钮，样式复用练习页
// 右上角 NF 快捷钮（#online_play .gicon.gmode 文本钮形态——30×30 暗底方钮、
// 灰字灰框，激活显站内黄 #fdc61d，hover 出正上方气泡说明）。
// 放置位置：筛选器（级别 tabs / 搜索框）右侧——/video 列表页页头、用户主页录像
// 版块标题行、首页录像区标题行三处；默认关闭，开启后只筛选显示 NF 录像。
// 因练习页样式选择器挂在 #online_play 作用域下，这里在 globals.css 复刻一套
// 通用 .nf_toggle（视觉参数与练习页逐项一致，不改动练习页原样式）。

"use client";

export function NfToggle({
  active,
  onToggle,
  tip = "只显示 NF 录像",
}: {
  /** 当前开关态（开启=只显示 NF 录像） */
  active: boolean;
  onToggle: (next: boolean) => void;
  /** hover 气泡文案（默认通用版；练习页口径文案「NF 模式：不能插旗…」不适用筛选场景） */
  tip?: string;
}) {
  return (
    <button
      type="button"
      className={`nf_toggle${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={() => onToggle(!active)}
    >
      NF
      <span className="tip">{tip}</span>
    </button>
  );
}
