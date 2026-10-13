// 个人主页侧栏「3BV 收集」版块（2026-10-13 张老师方案，设计稿 design/3bv-collection.html v3）
// 每个级别一行：级别名 + 已收集/总数 + 3px 进度条（同筛选器高亮线粗细）+ 方格墙。
// 方格区间 = level_3bv_range 表的站内统计区间（2026-10-14 张老师：下限按现行排行规则
// 钳到 LEVEL_MIN_3BV——初 2 / 中 30 / 高 100，低于下限的 3BV 不再统计完成度），每整数一格；
// 已收集=级别色（初绿/中橙/高黄），未收集=深灰。
// 悬停出 CSS 气泡（2026-10-13 张老师要求）：3BV 值 + 该 3BV 首个录像的上传日期；
// 未收集的格子显示「暂无录像」。
// 已收集方格点击新标签打开该 3BV 首个录像（2026-10-13 张老师要求，target=_blank 同站内录像链接惯例）。
// 纯服务端渲染：气泡也是纯 CSS（:hover 显隐），无 hydration、无 API 路由、无任何客户端 JS。

import Link from "next/link";
import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";
import { formatDate } from "@/lib/format";

export function BbvCollection({
  ranges,
  collected,
}: {
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  /** level -> (3BV -> 该 3BV 首个录像的 id 与上传时间 Unix 秒) */
  collected: Record<VideoLevel, Map<number, { vid: number; t: number }>>;
}) {
  return (
    <div className="box" id="user_3bv">
      <h2>3BV 收集</h2>
      {VIDEO_LEVELS.map((level) => {
        const range = ranges[level];
        if (!range) return null;
        const total = range.max - range.min + 1;
        if (total <= 0) return null;
        const map = collected[level];
        const n = map.size;
        const pct = (n / total) * 100;
        return (
          <div className={`bbv_level ${level}`} key={level}>
            <div className="bbv_head">
              <span className="bbv_name">{LEVEL_NAMES[level]}</span>
              <span className="bbv_stat">
                <em>{n}</em>/{total}
              </span>
            </div>
            <div className="bbv_bar">
              <div className="bbv_fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bbv_grid">
              {Array.from({ length: total }, (_, i) => {
                const b = range.min + i;
                const c = map.get(b);
                const tip = (
                  <i className="tip">
                    <b>3BV = {b}</b>
                    {c ? (
                      <span>首个录像 {formatDate(c.t, "Y-m-d")}</span>
                    ) : (
                      <span>暂无录像</span>
                    )}
                  </i>
                );
                return c ? (
                  <Link
                    key={b}
                    className="sq on"
                    href={`/video/${c.vid}`}
                    target="_blank"
                  >
                    {tip}
                  </Link>
                ) : (
                  <span key={b} className="sq">
                    {tip}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
