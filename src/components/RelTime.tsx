import { formatDate, timeOpposite } from "@/lib/format";

/**
 * 相对时间 + hover 气泡显示详细时间（2026-11-01 张老师要求）
 * 适用：新闻动态 / 录像列表 / 录像播放页 / 评论 / 论坛 / 消息 / 后台等所有相对时间处。
 * 气泡复用全站 data-tip 立即弹机制（同军衔徽章 / 无效 3BV/s），替代原生 title 的 1s 延迟；
 * 样式见 globals.css `.reltime[data-tip]`（暗底浅字小气泡，置于元素上方）。
 */
export function RelTime({
  time,
  max,
  format = "Y年n月j日 H:i",
  tipFormat = "Y年n月j日 H:i:s",
  className,
}: {
  /** Unix 秒 */
  time: number;
  /** 超过该秒数显示绝对时间（透传 timeOpposite；不传默认一天内相对） */
  max?: number;
  /** 相对超限后的绝对时间格式 */
  format?: string;
  /** 气泡内的详细时间格式 */
  tipFormat?: string;
  className?: string;
}) {
  return (
    <span
      className={className ? `reltime ${className}` : "reltime"}
      data-tip={formatDate(time, tipFormat)}
    >
      {timeOpposite(time, max, format)}
    </span>
  );
}
