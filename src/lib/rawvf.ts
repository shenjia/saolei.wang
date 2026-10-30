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
  /** 问号开关（AVF 头 QuestionMarks / MVF 头 Marks 行；回放引擎 toggleLabel 旗→问号分支依赖） */
  marks: boolean;
  board: string; // renderBoard 后的整盘字符串：'*' 或数字字符
  events: string[]; // RawVF 事件行（调试用，不入库）
}

/** Parser::renderBoard —— 把 '* / 0' 棋盘渲染为 '* / 数字'（统计八邻域雷数）
 *  历史注记：旧 PHP 站此处有负偏移回绕 bug（"$row[-1]" 取到行尾），导致最左列
 *  数字把同行最右格误算为邻居。移植初期为与旧库逐格一致曾复刻该怪癖；
 *  2026-10-13 张老师对照 Arbiter 实局确认数字错误，移除回绕修正为真实雷数，
 *  历史 board 串已由 scripts/sync/fix-board-numbers.py 按同逻辑无损重算。 */
export function renderBoard(board: string[]): string {
  const rows = board.map((r) => r.split(""));
  const Y = rows.length;
  const X = rows[0].length;
  const at = (y: number, x: number): string | undefined => {
    const row = rows[y];
    if (row === undefined) return undefined;
    if (x < 0 || x >= X) return undefined;
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
 * 上传最低软件版本检查（2026-10-24 张老师定稿）：
 *   Minesweeper Arbiter 0.52.3（avf）、元扫雷 3.3.4（evf）——低于版本生成的录像上传阶段拦截。
 * 口径说明：
 *   · avf 头部的版本字节只到主次版本（0.49/0.50/0.51/0.52，库内四档分布实证），
 *     补丁号（0.52.x 内的 .3）不在文件里——0.52 系列全放行，0.51 及以下拦。
 *   · evf 的 Software 字段自报「元X.Y.Z」（转换器已拆为 Program=元扫雷 + Version=X.Y.Z
 *     软件版本，2026-10-30），带完整补丁号，精确比较。
 *   · 其他软件（Clone/mvf 已有 "<=0.96" 检查、Viennasweeper 转码等）不在此规则内，返回 null 放行。
 * 返回 null = 通过；返回字符串 = 面向用户的拒绝原因。
 */
export function checkProgramVersion(program: string, version: string): string | null {
  const verCompare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };

  const p = program.trim();
  if (/^Arbiter\b/.test(p)) {
    // Arbiter：version 形如 "0.52"（fs 版 "R2" 等非常规串不在此规则内，放行）
    const m = /^(\d+)\.(\d+)$/.exec(version.trim());
    if (m && verCompare([Number(m[1]), Number(m[2])], [0, 52]) < 0) {
      return `Minesweeper Arbiter 版本过低（${version.trim()}），本站接受 0.52.3 及以上版本生成的录像`;
    }
    return null;
  }
  // 元扫雷（2026-10-30 拆分后）：program=「元扫雷」纯软件名，version 参数即软件版本
  if (p === "元扫雷") {
    const mv = /^(\d+(?:\.\d+){1,3})$/.exec(version.trim());
    if (mv && verCompare(mv[1].split(".").map(Number), [3, 3, 4]) < 0) {
      return `元扫雷版本过低（${mv[1]}），本站接受 3.3.4 及以上版本生成的录像`;
    }
    return null;
  }
  return null;
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
    marks: formatted.questionmarks === "on" || formatted.marks === "on",
    board: renderBoard(boardLines),
    events,
  };
}
