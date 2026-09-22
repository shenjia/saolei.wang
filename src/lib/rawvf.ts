// RawVF 中间表示与 Parser::format / renderBoard 的忠实移植
// 旧版管线：C 解析器把 mvf/avf 转成 RawVF 文本行 → PHP Parser::format 提取结构化字段
// 新版保持同样的两段式，便于与旧版 C 程序输出逐行 diff 校验

export interface ParsedVideo {
  level: string; // beg / int / exp（custom 会在上传校验时被拒）
  player: string; // 玩家签名（已从 gb2312 解码为 utf-8）
  program: string; // Clone / Arbiter
  version: string;
  mode: string; // classic / density / UPK / cheat
  width: number;
  height: number;
  mines: number;
  timeMs: number; // real_time（毫秒）
  bbbv: number | null; // 3BV（pre-0.97 录像没有该信息时为 null）
  solved3bv: number | null;
  noflag: boolean;
  board: string; // renderBoard 后的整盘字符串：'*' 或数字字符
  events: string[]; // RawVF 事件行（调试用，不入库）
}

/** Parser::renderBoard —— 把 '* / 0' 棋盘渲染为 '* / 数字'（统计八邻域雷数）
 *  必须复刻的 PHP 怪癖：PHP 7.1+ 字符串负偏移 "$row[-1]" 取该行**最后一格**，
 *  导致旧站生产的棋盘里，左边界格 (x=0) 的雷数会把同行 (x=max) 当作左邻（同行回绕）。
 *  右边界无此回绕（offset=X 越界 isset 为假）。已用库内真实录像逐格验证一致。 */
export function renderBoard(board: string[]): string {
  const rows = board.map((r) => r.split(""));
  const Y = rows.length;
  const X = rows[0].length;
  const at = (y: number, x: number): string | undefined => {
    const row = rows[y];
    if (row === undefined) return undefined;
    if (x < 0) return row[X - 1]; // PHP 负字符串偏移回绕到行尾
    if (x >= X) return undefined;
    return row[x];
  };
  for (let y = 0; y < Y; y++) {
    for (let x = 0; x < X; x++) {
      if (rows[y][x] === "*") continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dy && !dx) continue;
          if (at(y + dy, x + dx) === "*") count++;
        }
      }
      rows[y][x] = String(count);
    }
  }
  return rows.map((r) => r.join("")).join("");
}

/**
 * Parser::format —— 从 RawVF 文本行提取结构化字段
 * 忠实复刻 PHP 的两个怪癖：
 * 1. 值只取第一个冒号后的第一段（`explode(':')[1]`，含冒号的值会被截断，如 Timestamp）
 * 2. 无值的行（Board: / Events:）记录为「行号+1」，用作 array_slice 的起点
 */
export function formatRawvf(result: string[]): ParsedVideo {
  const formatted: Record<string, string | number> = {};
  result.forEach((line, i) => {
    const parts = line.split(":");
    if (parts.length === 1) return;
    const key = parts[0].toLowerCase();
    formatted[key] = parts[1] === "" ? i + 1 : parts[1].trim();
  });

  const height = Number(formatted.height);
  const boardStart = Number(formatted.board);
  const eventsStart = Number(formatted.events);
  const boardLines = result.slice(boardStart, boardStart + height);
  const events = result.slice(eventsStart);

  const timeStr = String(formatted.time ?? "0");
  const timeMs = Math.floor(parseFloat(timeStr) * 1000);

  return {
    level: String(formatted.level ?? "").slice(0, 3).toLowerCase(),
    // PHP 在此做 gb2312→utf-8；我们在二进制解析阶段已解码，这里直接透传
    player: String(formatted.player ?? ""),
    program: String(formatted.program ?? "").replace("Minesweeper ", ""),
    version: String(formatted.version ?? ""),
    mode: String(formatted.mode ?? ""),
    width: Number(formatted.width),
    height,
    mines: Number(formatted.mines),
    timeMs,
    bbbv: formatted["3bv"] !== undefined ? Number(formatted["3bv"]) : null,
    solved3bv: formatted["solved3bv"] !== undefined ? Number(formatted["solved3bv"]) : null,
    // 任一事件行含 'rc'（右键按下）即非 NF（strpos > 0，排除行首）
    noflag: !events.some((e) => e.indexOf("rc") > 0),
    board: renderBoard(boardLines),
    events,
  };
}
