// 扫雷棋盘，移植自 2013 版 PHP 的 Board 组件 + board.js（服务端直出，无需 JS）

import { BOARD_SIZE, type VideoLevel } from "@/lib/config";

export function Board({
  id,
  level,
  board,
  size = 8,
  zoomable = false,
  className = "",
}: {
  id: number | string;
  level: VideoLevel;
  board: string;
  size?: number;
  zoomable?: boolean;
  className?: string;
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
      className={`board ${level} size${size} ${className} ${zoomable ? "zoomable" : ""}`}
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
    </div>
  );
}
