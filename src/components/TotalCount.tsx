// 「加载更多」按钮右侧的计数灰字（2026-09-24 四轮：整体居中，按钮右侧灰字显示条数，数字微亮）
// 数字用 <em> 高亮一档（样式在 globals.css 的 .more_loader .total_count em）
// 2026-09-26（张老师要求）：全站口径改为「剩余 N 条」——传 loaded 时显示尚未加载的
//   剩余条数（剩余 0 = 已全部加载时回退显示总数，与旁侧「已加载全部」提示不重复；
//   不传 loaded 则保持纯总数语义，兼容 BBS 搜索栏等非「加载更多」计数场景）。

export function TotalCount({
  total,
  loaded,
  unit = "条",
}: {
  /** 当前筛选条件下的总数 */
  total: number;
  /** 已加载条数（「加载更多」场景传入，显示剩余） */
  loaded?: number;
  /** 计数单位（条/个/帖/位/人…） */
  unit?: string;
}) {
  const totalSafe = Math.max(0, total);
  const remain = loaded === undefined ? 0 : Math.max(0, totalSafe - loaded);
  return (
    <span className="total_count">
      {loaded !== undefined && remain > 0 ? (
        <>
          剩余 <em>{remain.toLocaleString("zh-CN")}</em> {unit}
        </>
      ) : (
        <>
          共 <em>{totalSafe.toLocaleString("zh-CN")}</em> {unit}
        </>
      )}
    </span>
  );
}
