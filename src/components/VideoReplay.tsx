"use client";

// 录像详情页原地回放（2026-10-15 张老师需求：点播放后棋盘原地进行回放，
// 复用在线练习自研回放的引擎口径——事件重演 + 光标插值 + 进即自动播完（固定 1x）。
//
// 数据：avf/mvf/rmv 解析器（与上传页浏览器端同一套，Uint8Array 入参，不碰 Buffer；
// ⚠️ rmv.ts 的 getNum 走 Uint8Array 直读不依赖 Buffer，浏览器端可用）；
// 解析失败 / 尺寸不符 → 兜底懒挂 flop 播放器（playFlop 全屏播放）。
//
// 事件应用口径（2026-10-16 四轮修正：flop 官方引擎源码 1:1 移植——已在 Node 原真运行
// flop webpack 模块作 gold standard 逐事件对照，26 判例全对齐；此前二/三轮的
// 「3x3 邻域 chord / 孤 lr＝首击 / 尾部 lc 补记」均为错误补偿——337484 误杀、
// 335360/335652 假败局皆由补丁制造——全部移除）：
//   lc → 仅置位（视觉按压，无游戏效果）；lr → 右/shift 按住＝单格 chord（仅光标下那格
//   opened 且 数字=0或=周围旗数 才开 3x3），否则以松开坐标开单格；复位 lp/lv/rv/sv 不动 rp；
//   rc → 左键按住仅视觉（不插旗）；否则 toggleLabel（旗→问号(marks)/摘旗、问号→清、未标→旗）；
//   rr → 左键按住＝单格 chord；复位 rp/lv/rv/sv 不动 lp；mc/mr 中键（mr 松开时单格 chord）；
//   sc → 置位 shift，chord 在其后的 lr 生效；mt → 切问号开关；
//   开格：opened/flagged 跳过、questioned 可开、0 号泛洪、踩雷 Blast 即时揭示。
//
// 九期（2026-10-16 张老师需求）：回放时左侧弹「数据统计」面板（复用练习页 greport
// 形态与口径，随回放实时刷新）+ 棋盘下方控制条（暂停/播放按钮 + 可拖拽进度条，
// 翻页控件卡片风格）。统计计数与 lib/videoradar.ts replayEvents 同一 flop 口径
// （Left/Right/Double/wasted 细项、Ce=Cl−wasted、Path 按事件像素欧氏累加）；
// solvedBv/Ops/Isls 与练习页 compute3BV/statsReport 同法（regions/singles/islands）。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Board } from "./Board";
import { FlopSprites } from "./FlopSprites";
import { FlopPlayer, playFlop } from "./FlopPlayer";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvf } from "@/lib/mvf";
import { rmvToRawvf } from "@/lib/rmv";
import { formatRawvf } from "@/lib/rawvf";
import type { VideoLevel } from "@/lib/config";

/* RawVF 事件行 → 紧凑事件（csec 统一百分秒；px/py 为 16px/格 像素坐标） */
interface ReplayEv {
  csec: number;
  ev: string;
  px: number;
  py: number;
}

interface ReplayData {
  w: number;
  h: number;
  /** renderBoard 后的整盘串（'*'=雷，其余=数字），与页面 Board 同源格式 */
  board: string;
  evs: ReplayEv[];
  totalCsec: number;
  /** 问号开关（toggleLabel 的旗→问号分支依赖） */
  marks: boolean;
}

/** avf/mvf/rmv 二进制 → 回放数据；不可解析返回 null（调用方走 flop 兜底）。
 *  timeCsecOverride：库内权威用时（video_info.real_time，百分秒）——进度条总长与
 *  播放终点以库为准（页面标题成绩同一来源），缺省退回文件内 Time。 */
function parseReplayData(buf: Uint8Array, ext: string, timeCsecOverride?: number): ReplayData | null {
  let lines: string[] | null = null;
  try {
    lines =
      ext === "avf"
        ? avfToRawvf(buf)
        : ext === "mvf"
          ? mvfToRawvf(buf)
          : ext === "rmv"
            ? rmvToRawvf(buf)
            : null;
  } catch {
    return null;
  }
  if (!lines) return null;
  const v = formatRawvf(lines);
  if (!v.width || !v.height || !v.board || v.board.length !== v.width * v.height) return null;
  const evs: ReplayEv[] = [];
  let lastCsec = 0;
  for (const line of v.events) {
    // 行形态：`ts ev col row (px py)`（与 videoradar replayEvents 同一正则）
    const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    const csec = Math.round(parseFloat(m[1]) * 100);
    evs.push({ csec, ev: m[2], px: +m[5], py: +m[6] });
    if (csec > lastCsec) lastCsec = csec;
  }
  if (!evs.length) return null;
  evs.sort((a, b) => a.csec - b.csec); // 保险：解析器本就时序输出，稳定排序不破坏同刻顺序
  return {
    w: v.width,
    h: v.height,
    board: v.board,
    evs,
    // 终点取「最后事件」与「权威用时」的较大者：最后开格后计时器还走着，
    // 停在 totalCsec 与真实对局节奏一致（练习页引擎用 s.csec 同理）
    totalCsec: Math.max(lastCsec, timeCsecOverride ?? Math.round(v.timeMs / 10)),
    marks: v.marks,
  };
}

/* ---- 实时统计快照（九期：数据面板行值，口径＝练习页 statsReport 的输入面） ---- */
export interface ReplayStats {
  /** 当前回放时钟（百分秒） */
  csec: number;
  totalCsec: number;
  board3bv: number;
  solvedBv: number;
  solvedOps: number;
  totalOps: number;
  solvedIsls: number;
  totalIsls: number;
  clLeft: number;
  clRight: number;
  clDouble: number;
  ce: number;
  /** 鼠标行程（像素） */
  path: number;
  /** 当前盘面旗数 */
  flags: number;
}

/* ---- 回放引擎（结构对齐练习页 OnlinePlay.startInPlaceReplay）---- */

interface Engine {
  restart: () => void;
  stop: () => void;
  /** 暂停（定格当前盘面与统计） */
  pause: () => void;
  /** 继续播放（已在终点则从头重播） */
  resume: () => void;
  /** 跳转：重置盘面后快进到目标时刻（counters 随 applyEv 重建） */
  seek: (csec: number) => void;
}

function runReplay(opts: {
  wrap: HTMLElement;
  tbody: HTMLTableSectionElement;
  rows: number;
  cols: number;
  data: ReplayData;
  onEnd: () => void;
  onStats: (s: ReplayStats) => void;
}): Engine {
  const { wrap, tbody, rows, cols, data, onEnd, onStats } = opts;
  const N = rows * cols;
  const mines = new Uint8Array(N);
  const nums = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const ch = data.board[i];
    if (ch === "*") mines[i] = 1;
    else nums[i] = ch.charCodeAt(0) - 48;
  }
  /* 邻居表（懒建缓存） */
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
  /* ---- 3BV 结构（练习页 compute3BV 同法）：空格连通域 regions（含边界数字格）、
     其余非雷格 singles、singles 八连连通域 islands —— solvedBv/Ops/Isls 的分母 ---- */
  const region = new Int32Array(N).fill(-1);
  let regions = 0;
  for (let i = 0; i < N; i++) {
    if (mines[i] || nums[i] !== 0 || region[i] !== -1) continue;
    const stack = [i];
    region[i] = regions;
    while (stack.length) {
      const c = stack.pop()!;
      for (const a of nbR(c)) {
        if (mines[a] || region[a] === regions) continue;
        region[a] = regions;
        if (nums[a] === 0) stack.push(a);
      }
    }
    regions++;
  }
  const bvRegions: number[][] = Array.from({ length: regions }, () => []);
  const bvSingles: number[] = [];
  for (let c = 0; c < N; c++) {
    if (mines[c]) continue;
    if (region[c] >= 0) bvRegions[region[c]].push(c);
    else bvSingles.push(c);
  }
  const singleSet = new Uint8Array(N);
  const seenIsl = new Uint8Array(N);
  for (const c of bvSingles) singleSet[c] = 1;
  const bvIslands: number[][] = [];
  for (const s of bvSingles) {
    if (seenIsl[s]) continue;
    const isl: number[] = [];
    const stack = [s];
    seenIsl[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      isl.push(c);
      for (const a of nbR(c)) {
        if (singleSet[a] && !seenIsl[a]) {
          seenIsl[a] = 1;
          stack.push(a);
        }
      }
    }
    bvIslands.push(isl);
  }
  const board3bv = regions + bvSingles.length;
  /* 回放状态机（0 未开 / 1 开 / 2 旗 / 3 问号）+ 原图类名备份（stop 恢复静态地图） */
  const rstate = new Uint8Array(N);
  const saved = new Array<string>(N);
  const cellTd = (i: number) => tbody.rows[(i / cols) | 0].cells[i % cols];
  for (let i = 0; i < N; i++) saved[i] = cellTd(i).className;
  let marks = data.marks;
  function paintR(i: number) {
    const td = cellTd(i);
    let cls = "bb";
    if (rstate[i] === 1) cls = "b" + nums[i];
    else if (rstate[i] === 2) cls = "bf";
    else if (rstate[i] === 3) cls = "bq";
    td.className = cls;
  }
  function floodR(i: number) {
    const stack = [i];
    while (stack.length) {
      const c = stack.pop()!;
      if (rstate[c] !== 0 || mines[c]) continue;
      rstate[c] = 1;
      paintR(c);
      if (nums[c] === 0) for (const a of nbR(c)) if (rstate[a] === 0) stack.push(a);
    }
  }
  /* ---- flop 口径计数（与 lib/videoradar.ts replayEvents 同一状态机计数分支）---- */
  let cLeft = 0;
  let cRight = 0;
  let cDouble = 0;
  let wastedLeft = 0;
  let wastedRight = 0;
  let wastedDouble = 0;
  let pathPx = 0;
  let lastPX: number | null = null;
  let lastPY = 0;
  /* 回放光标：flop 同款箭头（#cursor-arrow，FlopSprites 已内置；练习页同款 .replay_cursor）。
     箭头坐标域 0-120 × 0-190、尖端 (5,12)——事件像素坐标对准尖端。
     渲染尺寸 12×19 = viewBox 的 1/10，尖端显示像素 = (5,12.12)×0.1 ≈ (0.5,1.21)
     （此前误按 viewBox 坐标 (5,12) 整像素减，偏移放大 10 倍，尖端扎在格子左上角——2026-10-15 张老师报）。
     坐标换算：事件像素是棋盘 1x 坐标 → 宿主 .play_board 局部坐标需加 table 相对
     wrap 的静态偏移（.board 有 2px 边框，运行时一次量取） */
  const curEl = document.createElement("div");
  curEl.className = "replay_cursor";
  curEl.innerHTML =
    '<svg viewBox="0 0 120 190" width="12" height="19" aria-hidden="true"><use href="#cursor-arrow" /></svg>';
  wrap.appendChild(curEl);
  const table = tbody.parentElement as HTMLTableElement;
  const off = (() => {
    const tr = table.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    return { x: tr.left - wr.left, y: tr.top - wr.top };
  })();
  const TIP_X = 0.5,
    TIP_Y = 1.21;
  function moveCursor(px: number, py: number) {
    curEl.style.left = px + off.x - TIP_X + "px";
    curEl.style.top = py + off.y - TIP_Y + "px";
  }
  /* 事件应用：flop 状态机（2026-10-16 四轮修正口径，见文件头注释） */
  const evs = data.evs;
  let lp = false; // leftPressed
  let lv = false; // leftValid
  let rp = false; // rightPressed
  let rv = false; // rightValid
  let sv = false; // shiftValid
  let dead = false; // 踩雷：对局即时结束（雷区已揭示），后续事件只动光标
  let hitIdx = -1;
  const inb = (px: number, py: number) => px >= 0 && py >= 0 && px < cols * 16 && py < rows * 16;
  const idxOf = (px: number, py: number) => ((py / 16) | 0) * cols + ((px / 16) | 0);
  /* flop open()：开单格（questioned 可开、flagged 跳过、0 号泛洪、踩雷 Blast）；
     返回是否真的开了（wasted 计数依据，flop openCell 同语义） */
  function openR(px: number, py: number): boolean {
    if (dead || !inb(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1 || rstate[i] === 2) return false;
    if (mines[i]) {
      hitIdx = i;
      dead = true;
      revealLoss(); // Blast：先于落子展示（flop 同样不把雷格画成数字格）
      return true;
    }
    rstate[i] = 1;
    paintR(i);
    if (nums[i] === 0)
      for (const a of nbR(i)) {
        if (dead) return true;
        if (rstate[a] === 0) floodR(a);
      }
    return true;
  }
  /* flop openAround()：单格 chord——仅光标下那格 opened 且 数字=0 或 =周围旗数 时开 3x3；
     返回是否开出了格（wastedDouble 依据） */
  function openAroundR(px: number, py: number): boolean {
    if (!inb(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] !== 1) return false;
    let fc = 0;
    for (const a of nbR(i)) if (rstate[a] === 2) fc++;
    if (!(nums[i] === 0 || nums[i] === fc)) return false;
    let any = false;
    for (const a of nbR(i)) {
      if (dead) return any;
      const x = a % cols;
      const y = (a / cols) | 0;
      if (rstate[a] === 0) any = openR(x * 16, y * 16) || any;
    }
    return any;
  }
  /* flop toggleLabel()：旗→问号(marks)/摘旗、问号→清除、未标→旗；返回是否可操作 */
  function toggleLabelR(px: number, py: number): boolean {
    if (!inb(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1) return false;
    if (marks && rstate[i] === 2) rstate[i] = 3;
    else if (rstate[i] === 2 || rstate[i] === 3) rstate[i] = 0;
    else rstate[i] = 2;
    paintR(i);
    return true;
  }
  /* 败局雷区揭示（踩雷瞬间；位图类：bc=踩中红叉雷 / bm=雷 / bn=错旗） */
  function revealLoss() {
    for (let i = 0; i < N; i++) {
      if (mines[i]) {
        if (rstate[i] !== 2 && rstate[i] !== 3) cellTd(i).className = i === hitIdx ? "bc" : "bm";
      } else if (rstate[i] === 2) {
        cellTd(i).className = "bn";
      }
    }
  }
  function applyEv(k: number) {
    const e = evs[k];
    moveCursor(e.px, e.py);
    if (dead) return;
    /* 鼠标行程（flop mouseMove 口径，videoradar 同法）：所有带坐标事件按时间序累加 */
    if (e.px !== 0 || e.py !== 0) {
      if (lastPX !== null) pathPx += Math.hypot(e.px - lastPX, e.py - lastPY);
      lastPX = e.px;
      lastPY = e.py;
    }
    if (e.ev === "mt") {
      marks = !marks;
      return;
    }
    if (e.ev === "mv") return;
    switch (e.ev) {
      case "lc":
        lp = lv = true;
        break;
      case "lr":
        // flop leftRelease：rp||sv → 双击；否则 lv → 左键开格（松开坐标）
        if (rp || sv) {
          cDouble++;
          if (!openAroundR(e.px, e.py)) wastedDouble++;
        } else if (lv) {
          cLeft++;
          if (!openR(e.px, e.py)) wastedLeft++;
        }
        lp = lv = rv = sv = false; // 不动 rp（flop 原样）
        break;
      case "rc":
        // flop rightPress：lp 按住时仅视觉；否则按下即刻 toggleLabel（计数同 videoradar）
        if (!lp) {
          if (toggleLabelR(e.px, e.py)) {
            cRight++;
            rv = false;
          } else {
            rv = true;
          }
        }
        rp = true;
        break;
      case "rr":
        // flop rightRelease：lp 按住时＝双击；否则 rv 挂起补记一次 wasted 右键
        if (lp) {
          cDouble++;
          if (!openAroundR(e.px, e.py)) wastedDouble++;
        } else if (rv) {
          cRight++;
          wastedRight++;
        }
        rp = lv = rv = sv = false; // 不动 lp（flop 原样）
        break;
      case "mc":
        // mp = true（仅视觉按压）
        break;
      case "mr":
        cDouble++;
        if (!openAroundR(e.px, e.py)) wastedDouble++;
        break;
      case "sc":
        lp = lv = sv = true; // chord 在其后的 lr 生效
        break;
    }
  }
  /* 统计快照（solved 系按 rstate 现算，≤480 格零开销；派生值 Est/QG/STNB 由面板组件算） */
  function buildStats(): ReplayStats {
    let solvedBv = 0;
    let solvedOps = 0;
    for (const reg of bvRegions) {
      let ok = true;
      for (const c of reg)
        if (rstate[c] !== 1) {
          ok = false;
          break;
        }
      if (ok) {
        solvedBv++;
        solvedOps++;
      }
    }
    for (const c of bvSingles) if (rstate[c] === 1) solvedBv++;
    let solvedIsls = 0;
    for (const isl of bvIslands) {
      let ok = true;
      for (const c of isl)
        if (rstate[c] !== 1) {
          ok = false;
          break;
        }
      if (ok) solvedIsls++;
    }
    let flags = 0;
    for (let i = 0; i < N; i++) if (rstate[i] === 2) flags++;
    const cl = cLeft + cRight + cDouble;
    const ce = cl - (wastedLeft + wastedRight + wastedDouble);
    return {
      csec: curCsec,
      totalCsec: data.totalCsec,
      board3bv,
      solvedBv,
      solvedOps,
      totalOps: bvRegions.length,
      solvedIsls,
      totalIsls: bvIslands.length,
      clLeft: cLeft,
      clRight: cRight,
      clDouble: cDouble,
      ce,
      path: pathPx,
      flags,
    };
  }
  /* rAF 驱动（九期起支持暂停/继续/拖拽；统计按 ~100ms 节流回传） */
  let evIdx = 0;
  let curCsec = 0;
  let playing = false;
  let rafId: number | null = null;
  let lastFrame = 0;
  let lastStatTs = 0;
  function setPlaying(v: boolean) {
    playing = v;
    if (v) {
      if (curCsec >= data.totalCsec) resetReplay();
      lastFrame = 0;
      rafId = requestAnimationFrame(tick);
    } else if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  function resetReplay() {
    rstate.fill(0);
    lp = lv = rp = rv = sv = false;
    marks = data.marks;
    dead = false;
    hitIdx = -1;
    cLeft = cRight = cDouble = wastedLeft = wastedRight = wastedDouble = 0;
    pathPx = 0;
    lastPX = null;
    for (let i = 0; i < N; i++) paintR(i);
    evIdx = 0;
    curCsec = 0;
    moveCursor(0, 0);
  }
  /* 光标插值（练习页同款，治一顿一顿）：每帧在「最近已应用事件」与「下一事件」间线性补间 */
  function interpCursor(csec: number) {
    const prev = evIdx > 0 ? evs[evIdx - 1] : null;
    const next = evIdx < evs.length ? evs[evIdx] : null;
    if (!prev) {
      if (next) moveCursor(next.px, next.py);
      return;
    }
    if (!next) {
      moveCursor(prev.px, prev.py);
      return;
    }
    const t =
      next.csec > prev.csec ? Math.max(0, Math.min(1, (csec - prev.csec) / (next.csec - prev.csec))) : 1;
    moveCursor(prev.px + (next.px - prev.px) * t, prev.py + (next.py - prev.py) * t);
  }
  function tick(ts: number) {
    if (!playing) return;
    const dt = lastFrame ? (ts - lastFrame) / 10 : 0; // ms → 百分秒
    lastFrame = ts;
    const target = Math.min(data.totalCsec, curCsec + dt);
    while (evIdx < evs.length) {
      if (evs[evIdx].csec > target) break;
      applyEv(evIdx);
      evIdx++;
    }
    curCsec = target;
    interpCursor(target);
    if (target >= data.totalCsec) {
      setPlaying(false);
      onStats(buildStats()); // 终值先于 ended 状态落地（面板/进度条一步到位）
      onEnd(); // 定格终局画面（练习页桌面口径）；退出由棋盘点击 / Esc / stop 负责
      return;
    }
    if (ts - lastStatTs >= 100) {
      lastStatTs = ts;
      onStats(buildStats());
    }
    rafId = requestAnimationFrame(tick);
  }
  resetReplay();
  setPlaying(true);
  onStats(buildStats()); // 起播即出面板（全 0 值），不等首帧
  return {
    restart() {
      setPlaying(false);
      resetReplay();
      setPlaying(true);
      onStats(buildStats());
    },
    stop() {
      setPlaying(false);
      curEl.remove();
      for (let i = 0; i < N; i++) cellTd(i).className = saved[i];
    },
    pause() {
      if (!playing) return;
      setPlaying(false);
      onStats(buildStats());
    },
    resume() {
      if (playing) return;
      setPlaying(true);
    },
    seek(csec: number) {
      setPlaying(false);
      resetReplay();
      const target = Math.max(0, Math.min(data.totalCsec, Math.round(csec)));
      while (evIdx < evs.length) {
        if (evs[evIdx].csec > target) break;
        applyEv(evIdx);
        evIdx++;
      }
      curCsec = target;
      interpCursor(target);
      onStats(buildStats());
    },
  };
}

/* ---- React 外壳：Provider（引擎/缓存/flop 兜底）+ Board + Panel + Bar + Button ---- */

type Status = "idle" | "loading" | "playing" | "paused" | "ended";

interface ReplayCtxValue {
  status: Status;
  stats: ReplayStats | null;
  play: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** 播放/暂停切换（控制条按钮）；ended 态＝从头重播 */
  togglePlay: () => void;
  /** 跳转到指定百分秒（引擎重置盘面后快进，统计随发） */
  seek: (csec: number) => void;
}

const ReplayCtx = createContext<ReplayCtxValue | null>(null);

export function VideoReplayProvider({
  boardId,
  filepath,
  realTimeMs,
  children,
}: {
  /** Board 组件渲染的 id="board_{boardId}"，play() 时据此定位棋盘 DOM */
  boardId: number;
  filepath: string;
  /** 库内权威用时（毫秒，video_info.real_time）：进度条总长与播放终点以库为准 */
  realTimeMs?: number;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [stats, setStats] = useState<ReplayStats | null>(null);
  /* flop 兜底（rmv / 解析失败）：FlopPlayer 懒挂，挂上后再 playFlop。
     子组件 effect 先于本组件 effect 执行 → 届时 window.flop 已建好；
     播放器 iframe 未就绪时 playFlop 的 pendingUri 队列自动兜底 */
  const [flopUri, setFlopUri] = useState<string | null>(null);
  /* undefined＝未加载；null＝试过但失败（后续直接走 flop，不重复拉取） */
  const dataRef = useRef<ReplayData | null | undefined>(undefined);
  const engineRef = useRef<Engine | null>(null);

  const uri = `/videos${filepath}`;

  useEffect(() => {
    if (flopUri && window.flop) playFlop(flopUri);
  }, [flopUri]);

  const play = useCallback(() => {
    /* 回放中/已结束再点＝从头重播（练习页六期口径） */
    if (engineRef.current) {
      engineRef.current.restart();
      setStatus("playing");
      return;
    }
    const boardEl = document.getElementById(`board_${boardId}`);
    const wrap = (boardEl?.closest(".play_board") as HTMLElement | null) ?? null;
    const tbody = boardEl?.querySelector("tbody");
    if (!wrap || !tbody) return;
    const rows = (tbody as HTMLTableSectionElement).rows.length;
    const cols = rows ? (tbody as HTMLTableSectionElement).rows[0].cells.length : 0;
    if (!rows || !cols) return;
    const ext = (filepath.split(".").pop() || "").toLowerCase();
    if (ext !== "avf" && ext !== "mvf" && ext !== "rmv") {
      // rmf 等站内无解析器的格式 → flop 播放器兜底
      setFlopUri(uri);
      return;
    }
    setStatus("loading");
    void (async () => {
      try {
        if (dataRef.current === undefined) {
          const res = await fetch(uri);
          if (!res.ok) throw new Error(String(res.status));
          dataRef.current = parseReplayData(
            new Uint8Array(await res.arrayBuffer()),
            ext,
            realTimeMs ? Math.round(realTimeMs / 10) : undefined
          );
        }
        const data = dataRef.current;
        /* 尺寸不符（盘面与文件对不上，理论不至）或解析失败 → flop 兜底 */
        if (!data || data.w !== cols || data.h !== rows) {
          dataRef.current = null;
          setStatus("idle");
          setFlopUri(uri);
          return;
        }
        /* 极端并发（加载完成与用户二次点击同拍）：已有引擎就重播，不双开 */
        if (engineRef.current) {
          engineRef.current.restart();
          setStatus("playing");
          return;
        }
        engineRef.current = runReplay({
          wrap,
          tbody: tbody as HTMLTableSectionElement,
          rows,
          cols,
          data,
          onEnd: () => setStatus("ended"),
          onStats: setStats,
        });
        setStatus("playing");
      } catch {
        dataRef.current = null;
        setStatus("idle");
        setFlopUri(uri);
      }
    })();
  }, [boardId, filepath, realTimeMs, uri]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    setStats(null);
    setStatus("idle");
  }, []);

  const pause = useCallback(() => {
    engineRef.current?.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.resume();
    setStatus("playing");
  }, []);

  const togglePlay = useCallback(() => {
    if (status === "playing") pause();
    else if (status === "paused" || status === "ended") resume();
  }, [status, pause, resume]);

  const seek = useCallback((csec: number) => {
    engineRef.current?.seek(csec);
  }, []);

  /* Esc 退出回放（练习页同款出口之一） */
  useEffect(() => {
    if (status === "idle") return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [status, stop]);

  /* 卸载清理（软导航离开页面时停引擎、恢复/释放 DOM） */
  useEffect(
    () => () => {
      engineRef.current?.stop();
      engineRef.current = null;
    },
    []
  );

  return (
    <ReplayCtx.Provider value={{ status, stats, play, stop, pause, resume, togglePlay, seek }}>
      {children}
      {/* 光标贴图定义（隐藏 svg defs，含 #cursor-arrow） */}
      <FlopSprites />
      {flopUri && <FlopPlayer />}
    </ReplayCtx.Provider>
  );
}

/** 左侧数据面板（九期）：练习页「数据统计」同款行集/口径/气泡，随 stats 实时刷新。
 *  行值派生（Est/QG/RQP/STNB）与练习页 statsReport 同式——不要在这里改公式 */
function ReplayStatsPanel({ level, s }: { level: VideoLevel; s: ReplayStats }) {
  const ref = useRef<HTMLDivElement>(null);
  /* 宽高自适应（练习页 syncReportZoom 同思路）：面板锚在 .playable 左缘外 14px，
     可用宽＝棋盘左缘绝对坐标 − 12（视口余量）− 14（间隙）；面板高于「棋盘+控制条」
     整块时按整块高封顶；下限 0.3（练习页同款「宁可小也不越界」） */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const host = el.closest(".playable");
      if (!host) return;
      el.style.zoom = "1";
      const pr = el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      if (pr.width < 1 || pr.height < 1) return;
      const zW = (hr.left - 12 - 14) / pr.width;
      const zH = hr.height > 1 ? hr.height / pr.height : 1;
      el.style.zoom = String(Math.max(0.3, Math.min(1, zW, zH)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const t = s.csec / 100;
  const f3 = (v: number) => v.toFixed(3);
  const hasBv = s.solvedBv > 0 && t > 0;
  const est = hasBv ? t * (s.board3bv / s.solvedBv) : 0;
  const qg = hasBv ? Math.pow(t, 1.7) / s.solvedBv : 0;
  /* STNB 难度系数（标准级别；公式与练习页 statsReport / lib/videoradar stnbOf 同式） */
  const ln = level === "beg" ? 1 : level === "int" ? 2 : 3;
  const stnb = hasBv
    ? ((87.42 * ln * ln - 155.829 * ln + 115.708) / qg) * Math.sqrt(s.solvedBv / s.board3bv)
    : 0;
  const cl = s.clLeft + s.clRight + s.clDouble;
  const rows: [string, string, string][] = [
    ["RTime", f3(t) + " (" + (Math.floor(t) + 1) + ")", "本局实际用时（秒），括号内为按秒进位的录像计分时间"],
    ["Est RTime", hasBv ? f3(est) + " (" + (Math.floor(est) + 1) + ")" : "* (*)", "按完成度折算的估算用时 = 实际用时 × 3BV ÷ 已完成 3BV"],
    ["3BV", s.solvedBv + "/" + s.board3bv, "盘面理论最少点击次数（Bechtel 基准值），显示为 已完成 / 全盘总量"],
    ["3BV/s", hasBv ? f3(s.solvedBv / t) : "*", "每秒完成的 3BV 数 = 已完成 3BV ÷ 实际用时，衡量操作效率"],
    ["Ops", s.solvedOps + "/" + s.totalOps, "开空区域（opening）的完成数 / 全盘总数"],
    ["Isls", s.solvedIsls + "/" + s.totalIsls, "孤立数字块（island）的完成数 / 全盘总数"],
    ["Left", s.clLeft + "@" + (t > 0 ? f3(s.clLeft / t) : "0.000"), "左键点击次数 @ 每秒点击频率"],
    ["Right", s.clRight + "@" + (t > 0 ? f3(s.clRight / t) : "0.000"), "右键点击次数 @ 每秒点击频率"],
    ["Double", s.clDouble + "@" + (t > 0 ? f3(s.clDouble / t) : "0.000"), "左右同按（和弦双击）次数 @ 每秒频率"],
    ["Ce", s.ce + "@" + (t > 0 ? f3(s.ce / t) : "0.000"), "有效点击次数（真正开出新格或完成 3BV 的点击）@ 每秒频率"],
    ["Cl", cl + "@" + (t > 0 ? f3(cl / t) : "0.000"), "总点击次数（左键 + 右键 + 双击）@ 每秒频率"],
    ["IOE", cl > 0 ? f3(s.solvedBv / cl) : "*", "效率指数 = 已完成 3BV ÷ 总点击次数"],
    ["ThrP", s.ce > 0 ? f3(s.solvedBv / s.ce) : "*", "吞吐效率 = 已完成 3BV ÷ 有效点击次数"],
    ["Corr", cl > 0 ? f3(s.ce / cl) : "*", "准确率 = 有效点击 ÷ 总点击次数"],
    ["Path", String(Math.round(s.path)), "鼠标移动路径的欧氏距离总和（像素）"],
    ["Flags", String(s.flags), "玩家实际插旗数量（胜利时自动补的旗不计）"],
    ["RQP", hasBv ? f3((est * (est + 1)) / s.board3bv) : "*", "性价比 = 估算用时 × (估算用时 + 1) ÷ 3BV"],
    ["QG", hasBv ? f3(qg) : "*", "质量分 = 实际用时 ^ 1.7 ÷ 已完成 3BV"],
    ["STNB", hasBv ? f3(stnb) : "*", "无猜综合评分（按难度与完成度归一化，越大越好）"],
  ];
  return (
    <div className="replay_panel" ref={ref}>
      <div className="gr_title">数据统计</div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <td className="gt">{r[0]}</td>
              <td className="gv">
                {r[1]}
                <span className="tip">{r[2]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 控制条（九期）：暂停/播放按钮 + 可拖拽进度条，翻页控件卡片风格。
 *  拖拽：按住即暂停（记住原播放态），拖动中按帧 seek 实时预览，松手定位——
 *  拖前在播则松手续播；点轨道任意位置＝单次跳转（同语义）。 */
function ReplayBar({
  status,
  stats,
  onToggle,
  onPause,
  onSeek,
  onResume,
}: {
  status: Status;
  stats: ReplayStats;
  onToggle: () => void;
  onPause: () => void;
  onSeek: (csec: number) => void;
  onResume: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, wasPlaying: false, raf: 0, lastCsec: 0 });
  const total = stats.totalCsec;
  const pct = total > 0 ? Math.max(0, Math.min(1, stats.csec / total)) : 0;
  const posToCsec = (clientX: number) => {
    const track = trackRef.current;
    if (!track || total <= 0) return 0;
    const r = track.getBoundingClientRect();
    /* 轨道内衬 10px（.rb_rail 的 left/right），落点按内衬范围折算 */
    const inner = 10;
    const x = clientX - r.left - inner;
    const w = r.width - inner * 2;
    const ratio = w > 0 ? Math.max(0, Math.min(1, x / w)) : 0;
    return Math.round(ratio * total);
  };
  /* 按帧合并拖动 seek（pointermove 频率高于帧率，逐事件重放会白费） */
  const seekFrame = (clientX: number) => {
    const d = dragRef.current;
    d.lastCsec = posToCsec(clientX);
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        onSeek(d.lastCsec);
      });
    }
  };
  const cancelFrame = () => {
    const d = dragRef.current;
    if (d.raf) {
      cancelAnimationFrame(d.raf);
      d.raf = 0;
    }
  };
  useEffect(() => cancelFrame, []);
  const playing = status === "playing";
  return (
    <div className="replay_bar" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="rb_btn"
        title={playing ? "暂停" : "播放"}
        aria-label={playing ? "暂停" : "播放"}
        onClick={onToggle}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M7 4.8v14.4c0 .9 1 1.45 1.76.96l9.6-7.2a1.14 1.14 0 0 0 0-1.92l-9.6-7.2A1.14 1.14 0 0 0 7 4.8z" />
          </svg>
        )}
      </button>
      <span className="rb_time">{(stats.csec / 100).toFixed(2)}</span>
      <div
        className="rb_track"
        ref={trackRef}
        title="拖动跳转进度"
        onPointerDown={(e) => {
          const d = dragRef.current;
          d.active = true;
          d.wasPlaying = status === "playing";
          if (d.wasPlaying) onPause();
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFrame(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragRef.current.active) seekFrame(e.clientX);
        }}
        onPointerUp={(e) => {
          const d = dragRef.current;
          if (!d.active) return;
          d.active = false;
          cancelFrame();
          onSeek(posToCsec(e.clientX));
          if (d.wasPlaying) onResume();
        }}
        onPointerCancel={() => {
          const d = dragRef.current;
          if (!d.active) return;
          d.active = false;
          cancelFrame();
          if (d.wasPlaying) onResume();
        }}
      >
        <div className="rb_rail">
          <div className="rb_fill" style={{ width: (pct * 100).toFixed(2) + "%" }} />
        </div>
        <div className="rb_thumb" style={{ left: (pct * 100).toFixed(2) + "%" }} />
      </div>
      <span className="rb_time">{(total / 100).toFixed(2)}</span>
    </div>
  );
}

/** 可回放棋盘（替代原 BoardPlay：idle 点棋盘/浮层播放；回放中/结束点棋盘退出恢复原图） */
export function VideoReplayBoard({
  id,
  level,
  board,
}: {
  id: number;
  level: VideoLevel;
  board: string;
}) {
  const ctx = useContext(ReplayCtx);
  if (!ctx) return null;
  const replaying = ctx.status !== "idle";
  return (
    <div className="playable">
      {/* 结构沿用原 BoardPlay：.play_board 浮动收缩盒＝棋盘本体，回放光标挂这里。
          引擎定位走 board_{id}（Provider 传 boardId），此处无需 ref */}
      {/* 九期：回放中在棋盘左侧弹数据面板（.playable 锚定，绝对定位不挤版式） */}
      {replaying && ctx.stats && <ReplayStatsPanel level={level} s={ctx.stats} />}
      <div
        className="play_board"
        title={replaying ? "点击退出回放" : "点击播放在线录像"}
        onClick={() => {
          if (ctx.status === "idle") ctx.play();
          else if (ctx.status !== "loading") ctx.stop();
        }}
      >
        <Board id={id} level={level} board={board} size={16} />
        {!replaying && (
          <button
            type="button"
            className="play_overlay"
            aria-label="播放在线录像"
            onClick={(e) => {
              e.stopPropagation();
              ctx.play();
            }}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
              <path d="M8 5.14v13.72c0 .96 1.05 1.54 1.86 1.03l10.44-6.86a1.22 1.22 0 0 0 0-2.06L9.86 4.11C9.05 3.6 8 4.18 8 5.14z" />
            </svg>
          </button>
        )}
        {/* 九期：回放控制条（棋盘正下方同宽；点击不冒泡到棋盘退出） */}
        {replaying && ctx.stats && (
          <ReplayBar
            status={ctx.status}
            stats={ctx.stats}
            onToggle={ctx.togglePlay}
            onPause={ctx.pause}
            onSeek={ctx.seek}
            onResume={ctx.resume}
          />
        )}
      </div>
    </div>
  );
}

/** 「播放」按钮（替代原 PlayButton）：加载中禁用；回放中/结束＝「重播」 */
export function VideoReplayButton() {
  const ctx = useContext(ReplayCtx);
  if (!ctx) return null;
  const { status } = ctx;
  const label = status === "loading" ? "加载中…" : status === "idle" ? "播放" : "重播";
  return (
    <button type="button" onClick={ctx.play} disabled={status === "loading"}>
      {status === "idle" || status === "loading" ? (
        <svg className="btn_icon" viewBox="0 0 18 18" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M4.5 3v12c0 .85.93 1.36 1.64.91l9.2-6a1.07 1.07 0 0 0 0-1.82l-9.2-6A1.07 1.07 0 0 0 4.5 3z" />
        </svg>
      ) : (
        <svg className="btn_icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
        </svg>
      )}
      {label}
    </button>
  );
}
