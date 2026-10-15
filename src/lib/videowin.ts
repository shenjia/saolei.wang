// 录像完整度判定（2026-10-15）：AVF 无「已完成 3BV」字段，必须靠事件流模拟判定胜负。
// 语义与 VideoReplay 回放引擎同源（以终态盘 ground truth 网格搜索锁定，22 盘胜局全开验证）：
//   左击 → 挂起，lr 松开时以松开坐标开格/chord（首击按下坐标失真，一律取松开）；
//   右键 → rc 按下即刻以按下坐标插旗/拔旗；
//   双键 chord（任一键在另一键按住时按下）→ 上膛，后松开时以该次松开坐标生效；
//   chord 作用域＝3x3 邻域（Arbiter 滑键 chord，mc 点在未开格/缝隙上也能 chord 邻近数字格——
//   2026-10-15 三轮修正：338721 用单格口径误判 incomplete，3x3 口径下 62.24s 3BV=91/flags=53/终局 151/151 与 flop 全程吻合）；
//   孤 lr ＝ 首击（Arbiter 有时首击只记松开，按下在流外）；
//   尾部未松开的 lc 按按下坐标补记（fatal click 无松开，踩雷局靠此判死）。
// 用途：上传校验（只有完整胜局可上传——2026-10-15 张老师要求，堵 AVF 败局漏网）。

export type VideoOutcome = "win" | "loss" | "incomplete";

export function judgeVideoOutcome(v: {
  width: number;
  height: number;
  board: string;
  events: string[];
}): VideoOutcome {
  const rows = v.height;
  const cols = v.width;
  const N = rows * cols;
  if (!rows || !cols || v.board.length !== N) return "incomplete";
  const mines = new Uint8Array(N);
  const nums = new Uint8Array(N);
  let safeCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = v.board[i];
    if (ch === "*") mines[i] = 1;
    else {
      nums[i] = ch.charCodeAt(0) - 48;
      safeCount++;
    }
  }
  const evs: { ev: string; px: number; py: number }[] = [];
  for (const line of v.events) {
    const m = /^([\d.]+) (lc|lr|rc|rr|mc|mr|sc) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (m) evs.push({ ev: m[2], px: +m[5], py: +m[6] });
  }
  if (!evs.length) return "incomplete";

  const nb: number[][] = new Array(N);
  const nbR = (i: number): number[] => {
    if (nb[i]) return nb[i];
    const x = i % cols,
      y = (i / cols) | 0,
      r: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) r.push(ny * cols + nx);
      }
    nb[i] = r;
    return r;
  };
  const rstate = new Uint8Array(N);
  let dead = false;
  let opened = 0;
  const floodR = (i: number) => {
    const stack = [i];
    while (stack.length) {
      const c = stack.pop()!;
      if (rstate[c] !== 0 || mines[c]) continue;
      rstate[c] = 1;
      opened++;
      if (nums[c] === 0) for (const a of nbR(c)) if (rstate[a] === 0) stack.push(a);
    }
  };
  const chordR = (i: number) => {
    if (i < 0 || rstate[i] !== 1 || nums[i] === 0) return;
    const around = nbR(i);
    let fc = 0;
    for (const a of around) if (rstate[a] === 2) fc++;
    if (fc !== nums[i]) return;
    for (const a of around) if (rstate[a] === 0) {
      if (mines[a]) {
        dead = true;
        return;
      }
      floodR(a);
    }
  };
  const inb = (px: number, py: number) => px >= 0 && py >= 0 && px < cols * 16 && py < rows * 16;
  const idxOf = (px: number, py: number) => ((py / 16) | 0) * cols + ((px / 16) | 0);
  const leftAt = (px: number, py: number) => {
    if (!inb(px, py)) return;
    const i = idxOf(px, py);
    if (rstate[i] === 1) chordR(i);
    else if (rstate[i] === 0) {
      if (mines[i]) {
        dead = true;
        return;
      }
      floodR(i);
    }
  };
  const rightAt = (px: number, py: number) => {
    if (!inb(px, py)) return;
    const i = idxOf(px, py);
    if (rstate[i] === 0) rstate[i] = 2;
    else if (rstate[i] === 2) rstate[i] = 0;
  };
  const chordAt = (px: number, py: number) => {
    if (!inb(px, py)) return;
    /* chord 作用域＝3x3 邻域（Arbiter 滑键 chord 口径，2026-10-15 三轮修正 338721 实证：
       点在未开格/缝隙上也能 chord 到邻域内满足旗数的已开数字格；flop 62.24s 3BV=91 终局 151/151 对表吻合） */
    const i = idxOf(px, py);
    const x = i % cols;
    const y = (i / cols) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        if (dead) return;
        chordR(ny * cols + nx);
      }
  };

  let lDown = false,
    rDown = false,
    armed = false,
    armedX = 0,
    armedY = 0,
    gestureL = false,
    pendL = -1;
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (dead) break;
    if (e.ev === "lc") {
      if (rDown) {
        armed = true;
        armedX = e.px;
        armedY = e.py;
        lDown = true;
        gestureL = true;
      } else {
        if (pendL >= 0) leftAt(evs[pendL].px, evs[pendL].py); // 残缺保险
        lDown = true;
        pendL = k;
      }
    } else if (e.ev === "lr") {
      lDown = false;
      if (armed) {
        chordAt(e.px, e.py);
        armed = false;
        pendL = -1;
      } else if (pendL >= 0) {
        leftAt(e.px, e.py);
        pendL = -1;
      } else if (!gestureL) {
        leftAt(e.px, e.py); // 孤 lr＝首击
      }
      gestureL = false;
    } else if (e.ev === "rc") {
      if (lDown) {
        armed = true;
        armedX = e.px;
        armedY = e.py;
        rDown = true;
      } else {
        rDown = true;
        rightAt(e.px, e.py);
      }
    } else if (e.ev === "rr") {
      rDown = false;
      if (armed) {
        chordAt(e.px, e.py);
        armed = false;
        pendL = -1;
      }
    } else if (e.ev === "mc" || e.ev === "sc") {
      chordAt(e.px, e.py);
    }
  }
  if (!dead) {
    if (pendL >= 0) leftAt(evs[pendL].px, evs[pendL].py); // 尾部补记（fatal click 无松开）
    else if (armed) chordAt(armedX, armedY);
  }
  if (dead) return "loss";
  return opened === safeCount ? "win" : "incomplete";
}
