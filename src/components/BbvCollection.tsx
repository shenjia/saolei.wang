// 个人主页侧栏「3BV 收集」版块（2026-10-13 张老师方案，设计稿 design/3bv-collection.html v3）
// 每个级别一行：级别名 + 已收集/总数 + 3px 进度条（同筛选器高亮线粗细）+ 方格墙。
// 方格区间 = level_3bv_range 表的站内实际上下限，每整数一格；
// 已收集=级别色（初绿/中橙/高黄），未收集=深灰；无跳转。
// 悬停出 CSS 气泡（2026-10-13 张老师要求）：3BV 值 + 该 3BV 首个录像的上传日期；
// 未收集的格子显示「暂无录像」。
// 纯服务端渲染：气泡也是纯 CSS（:hover 显隐），无 hydration、无 API 路由、无任何客户端 JS。

import { LEVEL_NAMES, VIDEO_LEVELS, type VideoLevel } from "@/lib/config";
import { formatDate } from "@/lib/format";

export function BbvCollection({
  ranges,
  collected,
}: {
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  /** level -> (3BV -> 该 3BV 首个录像的上传时间 Unix 秒) */
  collected: Record<VideoLevel, Map<number, number>>;
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
                const t = map.get(b);
                return (
                  <span key={b} className={t !== undefined ? "sq on" : "sq"}>
                    <i className="tip">
                      <b>3BV = {b}</b>
                      {t !== undefined ? (
                        <span>首个录像 {formatDate(t, "Y-m-d")}</span>
                      ) : (
                        <span>暂无录像</span>
                      )}
                    </i>
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
