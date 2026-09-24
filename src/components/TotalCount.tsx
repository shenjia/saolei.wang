// 「加载更多」按钮右侧的总数灰字（2026-09-24 四轮：整体居中，按钮右侧灰字显示条数，数字微亮）
// 数字用 <em> 高亮一档（样式在 globals.css 的 .more_loader .total_count em）

export function TotalCount({ total, unit = "条" }: { total: number; unit?: string }) {
  return (
    <span className="total_count">
      共 <em>{Math.max(0, total).toLocaleString("zh-CN")}</em> {unit}
    </span>
  );
}
