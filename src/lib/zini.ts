// Greedy ZiNi —— 最少点击数下界估计（2026-10-31，张老师提议）
//
// 1:1 复刻 ms-toollib base/src/zini.rs 的 cal_zini（确定性贪心，Elmar Zimmermann &
// Christoph Nikolaus 提出）。语义：已知全部雷位时，扫完一盘（开所有非雷格）所需的
// 最少点击次数估计——左键/右键/chord 各计 1 次。任何真人录像的 flop 口径总点击
// cl 理论上不可能低于 zini（人类不可能比已知雷位的最优贪心还少点）；低于即事件流
// 被剪辑或盘面被篡改，是比 0.8×3BV 统计线硬得多的物理下界。
//
// 算法：每轮选 premium 最高（相邻 3BV 贡献 − 数字 − 2）的非雷格——未开则点击、
// 标周围雷、chord 开邻域——重复至开完。确定性：同盘永远同值。
//
// ⚠️ 与 Rust 版逐行等价的三个细节（对拍零差异的前提，勿改）：
//   ① 格子索引是**列主序** i = col * height + row（Rust Vec<Vec<i32>> 按行存，
//      build_cells_ref 按 c 外层 r 内层 push，cells 顺序与 board 行主序不同）；
//   ② apply_zini 选 premium 最高的格子用严格 > 比较——并列时取**先遍历到**的
//      （index 最小的），遍历顺序即 cells 数组顺序，必须一致；
//   ③ flagaround/chord 的邻域范围 [rb,re]×[cb,ce] 含自身（Rust 原样）。
//
// 零依赖纯函数：服务端分拣（video-triage）/ 跑批脚本 / 后台展示共用。

/** 输入盘面：与 rawvf ParsedVideo.board 同构——长度 w*h 的字符串，"*"＝雷（行主序） */
export function calZini(boardStr: string, width: number, height: number): number {
  const size = width * height;
  if (size === 0 || boardStr.length !== size) return 0;

  // Zcell 平铺数组（与 Rust 同一顺序：c 外层 r 内层 → 列主序）
  const mine = new Uint8Array(size);
  const opening = new Uint32Array(size);
  const opening2 = new Uint32Array(size);
  const number = new Int32Array(size);
  const opened = new Uint8Array(size);
  const flagged = new Uint8Array(size);
  const premium = new Int32Array(size);

  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) {
      const i = c * height + r;
      mine[i] = boardStr.charCodeAt(r * width + c) === 42 /* "*" */ ? 1 : 0;
    }
  }

  // 邻域边界（含自身；Rust rb/re/cb/ce 语义）
  const rb = new Uint32Array(size);
  const re = new Uint32Array(size);
  const cb = new Uint32Array(size);
  const ce = new Uint32Array(size);
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) {
      const i = c * height + r;
      rb[i] = r > 0 ? r - 1 : r;
      re[i] = r < height - 1 ? r + 1 : r;
      cb[i] = c > 0 ? c - 1 : c;
      ce[i] = c < width - 1 ? c + 1 : c;
    }
  }

  // ---- initboard ----
  // getnumber：邻域（含自身）雷数。Rust 对所有格都算（雷格也有 number，chord 扫雷
  // 判定用的邻域含雷格时其 number 也会被读到，但 reveal 只对非雷格生效，无影响）。
  const getNumber = (index: number): number => {
    let res = 0;
    for (let rr = rb[index]; rr <= re[index]; rr++) {
      for (let cc = cb[index]; cc <= ce[index]; cc++) {
        if (mine[cc * height + rr]) res++;
      }
    }
    return res;
  };
  for (let i = 0; i < size; i++) {
    number[i] = getNumber(i);
    premium[i] = -number[i] - 2;
  }

  // openings 标号（process_opening 递归改迭代——255×255 大盘防栈溢出）
  let openings = 0;
  const setOpeningBorder = (opId: number, index: number) => {
    if (opening[index] === 0) opening[index] = opId;
    else if (opening[index] !== opId && opening2[index] === 0) opening2[index] = opId;
  };
  const processOpening = (opId: number, startIdx: number) => {
    const stack = [startIdx];
    opening[startIdx] = opId;
    while (stack.length) {
      const idx = stack.pop()!;
      for (let rr = rb[idx]; rr <= re[idx]; rr++) {
        for (let cc = cb[idx]; cc <= ce[idx]; cc++) {
          const i = cc * height + rr;
          if (number[i] !== 0) {
            setOpeningBorder(opId, i);
          } else if (opening[i] === 0) {
            opening[i] = opId;
            stack.push(i);
          }
        }
      }
    }
  };
  for (let i = 0; i < size; i++) {
    if (!mine[i] && number[i] === 0 && opening[i] === 0) {
      openings++;
      processOpening(openings, i);
    }
  }

  // getadj3bv：本格若被点击/开出的 3BV 贡献
  const getAdj3bv = (index: number): number => {
    if (number[index] === 0) return 1;
    let res = 0;
    for (let rr = rb[index]; rr <= re[index]; rr++) {
      for (let cc = cb[index]; cc <= ce[index]; cc++) {
        const i = cc * height + rr;
        if (!mine[i] && opening[i] === 0) res++;
      }
    }
    if (opening[index] !== 0) res++;
    if (opening2[index] !== 0) res++;
    return res;
  };
  for (let i = 0; i < size; i++) premium[i] += getAdj3bv(i);

  // ---- 主循环（zinialg，human=false, hitops=false）----
  let mines = 0;
  for (let i = 0; i < size; i++) mines += mine[i];
  let closedCells = size;
  let zini = 0;

  const openCell = (index: number) => {
    opened[index] = 1;
    premium[index] += 1;
    if (opening[index] === 0) {
      // 非Opening边界格：邻域 premium 全 -1
      for (let rr = rb[index]; rr <= re[index]; rr++) {
        for (let cc = cb[index]; cc <= ce[index]; cc++) {
          premium[cc * height + rr] -= 1;
        }
      }
    }
    closedCells--;
  };

  const reveal = (index: number) => {
    if (opened[index] || flagged[index]) return;
    if (number[index] !== 0) {
      openCell(index);
    } else {
      const op = opening[index];
      for (let i = 0; i < size; i++) {
        if (opening2[i] === op || opening[i] === op) {
          if (!opened[i]) openCell(i);
          premium[i] -= 1;
        }
      }
    }
  };

  const flag = (index: number) => {
    if (flagged[index]) return;
    zini++;
    flagged[index] = 1;
    for (let rr = rb[index]; rr <= re[index]; rr++) {
      for (let cc = cb[index]; cc <= ce[index]; cc++) {
        premium[cc * height + rr] += 1;
      }
    }
  };

  const click = (index: number) => {
    reveal(index);
    zini++;
  };

  const flagaround = (index: number) => {
    for (let rr = rb[index]; rr <= re[index]; rr++) {
      for (let cc = cb[index]; cc <= ce[index]; cc++) {
        const i = cc * height + rr;
        if (mine[i]) flag(i);
      }
    }
  };

  const chord = (index: number) => {
    zini++;
    for (let rr = rb[index]; rr <= re[index]; rr++) {
      for (let cc = cb[index]; cc <= ce[index]; cc++) {
        reveal(cc * height + rr);
      }
    }
  };

  // apply_zini（human=false：允许点击未开格）
  const applyZini = (): boolean => {
    let maxp = -1;
    let curi = -1;
    for (let i = 0; i < size; i++) {
      if (premium[i] > maxp && !mine[i]) {
        maxp = premium[i];
        curi = i;
      }
    }
    if (curi >= 0) {
      if (!opened[curi]) click(curi);
      flagaround(curi);
      chord(curi);
      return true;
    }
    // 兜底：随便点一个未开的非雷格（number=0 或不在 opening 边界上的）
    for (let i = 0; i < size; i++) {
      if (!opened[i] && !mine[i] && (number[i] === 0 || opening[i] === 0)) {
        click(i);
        return true;
      }
    }
    return false;
  };

  while (closedCells > mines) {
    if (!applyZini()) break;
  }
  return zini;
}
