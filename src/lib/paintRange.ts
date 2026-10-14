// 滑条填充自绘工具（2026-10-14 张老师定稿：填充 #8ac21b + 滑块 #a6e22e）。
// 原生 accent-color 无法拆分「填充条 / 滑块」两色，改自绘轨道（globals.css 公共块）后，
// 填充比例由 JS 写入 --pct（0-100，Chrome/Safari 渐变用；Firefox 走原生 ::-moz-range-progress 不需要）。
// 任何 value 变化（用户拖动 / 程序赋值）都要调用一次，否则填充条不动。
export function paintRangeFill(el: HTMLInputElement) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value) || 0;
  el.style.setProperty("--pct", max > min ? String(((val - min) / (max - min)) * 100) : "0");
}
