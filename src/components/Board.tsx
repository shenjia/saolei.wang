// 扫雷棋盘，移植自 2013 版 PHP 的 Board 组件 + board.js（服务端直出，无需 JS）

import { BOARD_SIZE, type VideoLevel } from "@/lib/config";

/* 矢量覆盖层（2026-10-30 张老师需求：详情页/回放位图雪碧图在版图非整数 zoom
   （int/exp 1.15、beg 2.6）下逐格重采样，格缘深浅不一＝细微错位）——换练习页
   2026-10-14 二次返工定稿的「整盘单 SVG 覆盖层」：所有格子共用一张坐标系一次
   光栅化，任意倍率网格完全均匀（flop 原版同构）。
   静态字符（数字 0-8 / b＝雷→未开面）→ FlopSprites symbol id；
   回放动态类（bb/bf/bq/bm/bn/bmb）映射在 VideoReplay 的 CELL_VEC_MAP。 */
const VEC_SYM: Record<string, string> = {
  b: "cell-normal-solid",
  "0": "cell-number-0",
  "1": "cell-number-1",
  "2": "cell-number-2",
  "3": "cell-number-3",
  "4": "cell-number-4",
  "5": "cell-number-5",
  "6": "cell-number-6",
  "7": "cell-number-7",
  "8": "cell-number-8",
};

export function Board({
  id,
  level,
  board,
  size = 8,
  zoomable = false,
  className = "",
  vec = false,
}: {
  id: number | string;
  level: VideoLevel;
  board: string;
  size?: number;
  zoomable?: boolean;
  className?: string;
  /** 矢量渲染（详情页/全屏层回放棋盘）：td 只担布局/命中/语义类，视觉走 SVG 覆盖层 */
  vec?: boolean;
}) {
  const dim = BOARD_SIZE[level] ?? BOARD_SIZE.beg;
  // * 表示雷，映射为 b（移植 board.js 的 replace(/\*/g, 'b')）
  const cells = board.replace(/\*/g, "b").split("");
  const rows: string[][] = [];
  for (let y = 0; y < dim.y; y++) {
    rows.push(cells.slice(y * dim.x, (y + 1) * dim.x));
  }
  return (
    <div
      id={`board_${id}`}
      className={`board ${level} size${size} ${className} ${zoomable ? "zoomable" : ""} ${vec ? "vec" : ""}`}
    >
      <table cellPadding={0} cellSpacing={0}>
        <tbody>
          {rows.map((row, y) => (
            <tr key={y}>
              {row.map((c, x) => (
                <td key={x} className={`b${c}`}></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {vec && (
        <svg
          className="vecboard"
          viewBox={`0 0 ${dim.x * 16} ${dim.y * 16}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* 底铺深灰（练习页同款 #808080＝cell-press 边框灰）：格缝/亚像素舍入缝透出均匀深灰细线 */}
          <rect x="0" y="0" width="100%" height="100%" fill="#808080" />
          {cells.map((c, i) => (
            <use
              key={i}
              href={`#${VEC_SYM[c] ?? "cell-normal-solid"}`}
              x={(i % dim.x) * 16}
              y={((i / dim.x) | 0) * 16}
              width={16}
              height={16}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
