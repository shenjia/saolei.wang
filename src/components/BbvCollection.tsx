// 个人主页侧栏「3BV 收集」版块（2026-10-13 张老师方案，设计稿 design/3bv-collection.html v3）
// 每个级别一行：级别名 + 已收集/总数 + 3px 进度条（同筛选器高亮线粗细）+ 方格墙。
// 方格区间 = level_3bv_range 表的站内实际上下限，每整数一格；
// 已收集=级别色（初绿/中橙/高黄），未收集=深灰；悬停原生 title 显示 3BV 值；无跳转。
// 纯服务端渲染：无 hydration、无 API 路由、无任何客户端 JS。

import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";

export function BbvCollection({
  ranges,
  collected,
}: {
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  collected: Record<VideoLevel, Set<number>>;
}) {
  return (
    <div className="box" id="user_3bv">
      <h2>3BV 收集</h2>
      {VIDEO_LEVELS.map((level) => {
        const range = ranges[level];
        if (!range) return null;
        const total = range.max - range.min + 1;
        if (total <= 0) return null;
        const set = collected[level];
        const n = set.size;
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
                return (
                  <span
                    key={b}
                    className={set.has(b) ? "sq on" : "sq"}
                    title={`3BV = ${b}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
