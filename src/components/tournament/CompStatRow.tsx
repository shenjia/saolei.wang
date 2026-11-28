// 比赛页右栏统计行（2026-11-28 张老师定：版式对齐首页「数据统计」SiteStats）
//
// 三列表格行：标签 | 数值 | 今日增量。
// · 数值列右对齐——各行数值右缘统一落在同一竖线，不随增量有无漂移；
// · 增量列独立成列（width:1px 按内容收缩 + 左对齐，样式见 globals.css
//   .comp_stat_table .delta），绿色括号「（+N）」，today 为 0/缺省时留空占位
//   ——与首页 #site_stats / 录像页 #video_stats / 个人主页 .stats_box 同款。
// 替代旧 flex 两端对齐的 .comp_stat_row（该结构详情页「成绩」「数据统计」仍在用）。
//
// num 是 ReactNode 而非 number：累计奖金等行需要金色 span（.gold）包裹。

export function CompStatRow({
  label,
  num,
  today,
}: {
  label: string;
  /** 数值单元格内容（可带 .gold 等着色 span） */
  num: React.ReactNode;
  /** 今日增量；>0 才显示「（+N）」，否则该格留空占位保证列宽一致 */
  today?: number;
}) {
  const hasDelta = today !== undefined && today > 0;
  return (
    <tr>
      <td className="label">{label}</td>
      <td className="num">{num}</td>
      <td className="delta">{hasDelta ? `（+${today}）` : ""}</td>
    </tr>
  );
}
