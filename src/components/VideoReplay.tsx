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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Board } from "./Board";
import { FlopSprites } from "./FlopSprites";
import { FlopPlayer, playFlop } from "./FlopPlayer";
import { VideoAnalysisRadar } from "./VideoAnalysis";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvfBest } from "@/lib/mvf-best";
import { rmvToRawvf } from "@/lib/rmv";
import { evfToRawvf } from "@/lib/evf";
import { formatRawvf } from "@/lib/rawvf";
import { LEVEL_NAMES, type VideoLevel } from "@/lib/config";
import type { MetricKey, VideoAnalysisPoint } from "@/lib/videoscore";
/* 五轴评级算法（共享件）；别名避开本文件里的 radarOverall 同名 prop */
import { gradeColor, radarOverall as overallGrade, radarPointsFrom } from "@/lib/videoscore";

/* RawVF 事件行 → 紧凑事件（csec 统一百分秒；px/py 为 16px/格 像素坐标） */
interface ReplayEv {
  csec: number;
  ev: string;
  px: number;
  py: number;
}

export interface ReplayData {
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
 *  播放终点以库为准（页面标题成绩同一来源），缺省退回文件内 Time。
 *  2026-10-19 导出：管理后台审核页全屏播放器（AdminVideoPlayer）复用同一解析。 */
export function parseReplayData(buf: Uint8Array, ext: string, timeCsecOverride?: number): ReplayData | null {
  let lines: string[] | null = null;
  try {
    lines =
      ext === "avf"
        ? avfToRawvf(buf)
        : ext === "mvf"
          ? (mvfToRawvfBest(buf)?.lines ?? null) // 择优口径：回放与判定同源（mvf-best.ts）
          : ext === "rmv"
            ? rmvToRawvf(buf)
            : ext === "evf"
              ? evfToRawvf(buf) // evf（元扫雷）：转换器内部已折算 16px 口径并消歧非标准码
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
    // ts 可为负（元扫雷 evf 的负值修正：开局前按下/标旗）——钳到 0：这类事件属于
    // 「开局瞬间的盘面状态」，必须在 0 点之前就位；留着负值会让它们落入插值区间之外，
    // 与首帧事件挤在一起乱跳（2026-10-27 347863 观感问题的一半原因）。
    const m = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    const csec = Math.max(0, Math.round(parseFloat(m[1]) * 100));
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
  /** 全盘雷数（十七期：全屏计数条 LED 雷数＝totalMines − flags） */
  totalMines: number;
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

/* ---- 3BV 结构（练习页 compute3BV 同法）：空格连通域 regions（含边界数字格）、
     其余非雷格 singles、singles 八连连通域 islands —— solvedBv/Ops/Isls 的分母。
     十七期抽成模块级共享：回放引擎与全屏试玩引擎同一份结构 ---- */
function buildBvStructures(
  mines: Uint8Array,
  nums: Uint8Array,
  nbR: (i: number) => number[],
): { bvRegions: number[][]; bvSingles: number[]; bvIslands: number[][]; board3bv: number } {
  const N = mines.length;
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
  return { bvRegions, bvSingles, bvIslands, board3bv: regions + bvSingles.length };
}

/* solved 扫描（buildStats/试玩实时统计共用）：按当前开格态算 solvedBv/Ops/Isls */
function solvedScan(
  st: { bvRegions: number[][]; bvSingles: number[]; bvIslands: number[][] },
  isOpen: (i: number) => boolean,
): { solvedBv: number; solvedOps: number; solvedIsls: number } {
  let solvedBv = 0;
  let solvedOps = 0;
  for (const reg of st.bvRegions) {
    let ok = true;
    for (const c of reg)
      if (!isOpen(c)) {
        ok = false;
        break;
      }
    if (ok) {
      solvedBv++;
      solvedOps++;
    }
  }
  for (const c of st.bvSingles) if (isOpen(c)) solvedBv++;
  let solvedIsls = 0;
  for (const isl of st.bvIslands) {
    let ok = true;
    for (const c of isl)
      if (!isOpen(c)) {
        ok = false;
        break;
      }
    if (ok) solvedIsls++;
  }
  return { solvedBv, solvedOps, solvedIsls };
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

/** 笑脸状态（十七期：练习页同款语义——按下 ooh / 松开 smile / 终局 win·dead）。
 *  2026-10-22 导出：后台审核播放器（AdminVideoPlayer standalone 模式）的
 *  engineFace prop 需要。 */
export type FaceKind = "smile" | "ooh" | "win" | "dead";
const FACE_MAP: Record<FaceKind | "press", string> = {
  smile: "face-normal",
  ooh: "face-press-cell",
  dead: "face-lose",
  win: "face-win",
  press: "face-press-normal",
};

/** 被踩中的雷：td 内嵌 flop 原版红底雷（#cell-mine-bomb，与练习页踩雷同图）。
 *  td 位图体系的 bc 贴图是灰调雷（block16x16.png 第 12 行无红色像素），
 *  2026-10-20 张老师定：全屏试玩/回放踩中格一律用带红底的雷图（和练习踩雷一样）。
 *  类名 bmb：globals.css 里 SVG 绝对定位脱流——inline SVG 固有尺寸会参与表格
 *  auto 布局把整列撑宽整行撑高（首版空类名+裸 SVG 的「页面乱了」教训）。
 *  依赖页面内的 FlopSprites（详情页/全屏层/后台播放器均已挂载）；
 *  paintR/paint/stop 恢复路径会重写 className+innerHTML，红雷自然被刷掉。 */
function paintBombCell(td: HTMLTableCellElement) {
  td.className = "bmb";
  td.innerHTML =
    '<svg viewBox="0 0 168 168" aria-hidden="true"><use href="#cell-mine-bomb" /></svg>';
}

/* 2026-10-19 导出：管理后台审核页全屏播放器（AdminVideoPlayer）复用同一引擎 */
export function runReplay(opts: {
  wrap: HTMLElement;
  tbody: HTMLTableSectionElement;
  rows: number;
  cols: number;
  data: ReplayData;
  onEnd: () => void;
  onStats: (s: ReplayStats) => void;
  /** 笑脸状态变化（练习页口径；全屏层计数条消费，页面态无消费者） */
  onFace?: (k: FaceKind) => void;
  /** 宿主生效 zoom 读取器（2026-10-22 standalone 模式）：默认量 wrap 自身
   *  computed zoom（页面态 .play_board 自带 zoom 类）；FS 层 zoom 挂祖先
   *  .vprfs_center，wrap 量不到 → 调用方传 getter（值变化时 off 重量取，
   *  滚轮改 --vfz 后光标锚点自动跟进） */
  getHostZoom?: () => number;
}): Engine {
  const { wrap, tbody, rows, cols, data, onEnd, onStats, onFace, getHostZoom } = opts;
  const N = rows * cols;
  const mines = new Uint8Array(N);
  const nums = new Uint8Array(N);
  let mineCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = data.board[i];
    if (ch === "*") {
      mines[i] = 1;
      mineCount++;
    } else nums[i] = ch.charCodeAt(0) - 48;
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
  /* ---- 3BV 结构（十七期抽共享 buildBvStructures）---- */
  const bvSt = buildBvStructures(mines, nums, nbR);
  const { board3bv } = bvSt; // solved 系走 solvedScan(bvSt)，结构体内部消费
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
    /* 清掉可能残留的内嵌红雷 SVG（paintBombCell；重置/seek/重播路径） */
    if (td.innerHTML) td.innerHTML = "";
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
  /* 十期：.play_board 有版图 zoom（exp/int 1.22、beg 1.5）——rect 是视觉坐标，
     写 style.left/top 是布局坐标（会被外层 zoom 再乘），须除回 wrap 的 zoom。
     standalone 模式（2026-10-22）：FS 层 zoom 挂祖先 .vprfs_center，wrap 自身
     量不到 → getHostZoom 由调用方传入；zoom 变化（滚轮 --vfz）时 off 重量取
     （off 是布局域 2px 边框差，视觉差/Z 恒等于它，重量取只是防漂移兜底） */
  const readZoom = () => {
    if (getHostZoom) {
      const z = getHostZoom();
      if (Number.isFinite(z) && z > 0) return z;
    }
    const z = parseFloat(getComputedStyle(wrap).zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  };
  let wrapZoom = readZoom();
  const off = (() => {
    const tr = table.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    return { x: (tr.left - wr.left) / wrapZoom, y: (tr.top - wr.top) / wrapZoom };
  })();
  /* 每帧光标移动前校验 zoom 漂移（滚轮缩放）：变了就重量 off——便宜且自愈 */
  function ensureZoom() {
    const z = readZoom();
    if (z === wrapZoom) return;
    wrapZoom = z;
    const tr = table.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    off.x = (tr.left - wr.left) / z;
    off.y = (tr.top - wr.top) / z;
  }
  const TIP_X = 0.5,
    TIP_Y = 1.21;
  function moveCursor(px: number, py: number) {
    ensureZoom();
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
  let won = false; // 胜局标记（十七期：终局笑脸 win/dead） */
  function openR(px: number, py: number): boolean {
    if (dead || !inb(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1 || rstate[i] === 2) return false;
    if (mines[i]) {
      hitIdx = i;
      dead = true;
      revealLoss(); // Blast：先于落子展示（flop 同样不把雷格画成数字格）
      onFace?.("dead");
      return true;
    }
    rstate[i] = 1;
    paintR(i);
    if (nums[i] === 0)
      for (const a of nbR(i)) {
        if (dead) return true;
        if (rstate[a] === 0) floodR(a);
      }
    checkWinR();
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
  /* 玩家实际旗数（2026-10-22 张老师报错）：rstate 现数会被 checkWinR 的胜利
     自动补旗污染（Flags 终值虚高）；练习页口径＝report 须在自动补旗之前。
     这里以 rc 事件流增量维护：rc 系玩家动作，toggleLabelR 命中才 +/-，
     checkWinR 的补旗不经此路 → 统计永不计自动旗 */
  let playerFlags = 0;
  /* flop toggleLabel()：旗→问号(marks)/摘旗、问号→清除、未标→旗；返回是否可操作 */
  function toggleLabelR(px: number, py: number): boolean {
    if (!inb(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1) return false;
    if (marks && rstate[i] === 2) {
      rstate[i] = 3;
      playerFlags--;
    } else if (rstate[i] === 2 || rstate[i] === 3) {
      if (rstate[i] === 2) playerFlags--;
      rstate[i] = 0;
    } else {
      rstate[i] = 2;
      playerFlags++;
    }
    paintR(i);
    return true;
  }
  /* 败局雷区揭示（踩雷瞬间；位图类：bm=雷 / bn=错旗） */
  function revealLoss() {
    for (let i = 0; i < N; i++) {
      if (mines[i]) {
        if (rstate[i] !== 2 && rstate[i] !== 3) cellTd(i).className = "bm";
      } else if (rstate[i] === 2) {
        cellTd(i).className = "bn";
      }
    }
    /* 被踩中的雷：flop 原版红底雷（#cell-mine-bomb，与练习页踩雷同图）——
       td 位图体系的 bc 贴图是灰调雷（无红色像素），2026-10-20 张老师报错纠正 */
    paintBombCell(cellTd(hitIdx));
  }
  /* 胜局检测（十七期：全安全格开完 → win 脸 + 自动补旗揭示，练习页 checkWin 同款；
     胜局录像收尾大多是滑键/chord 收官，事件流天然开满——补旗纯视觉不进事件） */
  function checkWinR() {
    if (won || dead) return;
    let opened = 0;
    for (let i = 0; i < N; i++) if (rstate[i] === 1) opened++;
    if (opened < N - mineCount) return;
    won = true;
    for (let i = 0; i < N; i++)
      if (mines[i] && rstate[i] !== 2) {
        rstate[i] = 2;
        paintR(i);
      }
    onFace?.("win");
  }
  function applyEv(k: number) {
    const e = evs[k];
    moveCursor(e.px, e.py);
    if (dead) return;
    /* 胜局后事件全无效（flop performEvent 守卫；同 videowin.ts 主循环）：
       不拦的话残余 rc 会拔走 rstate 旗——虽不再污染 playerFlags（rc 分支
       需 toggleLabelR 命中才计数，而拔的是自动补的旗），但 smile 联动与
       光标后挂事件会继续走，与 flop 终局定格不符 */
    if (won) return;
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
    /* 笑脸联动（十七期，练习页口径）：按下（lc/rc/sc）→ ooh、松开（lr/rr/mr）→ smile；
       终局 win/dead 落定后不再回 smile（dead 早退在上面拦截） */
    if (!dead && !won) {
      if (e.ev === "lc" || e.ev === "rc" || e.ev === "sc") onFace?.("ooh");
      else if (e.ev === "lr" || e.ev === "rr" || e.ev === "mr") onFace?.("smile");
    }
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
    const { solvedBv, solvedOps, solvedIsls } = solvedScan(bvSt, (i) => rstate[i] === 1);
    const cl = cLeft + cRight + cDouble;
    const ce = cl - (wastedLeft + wastedRight + wastedDouble);
    return {
      csec: curCsec,
      totalCsec: data.totalCsec,
      board3bv,
      totalMines: mineCount,
      solvedBv,
      solvedOps,
      totalOps: bvSt.bvRegions.length,
      solvedIsls,
      totalIsls: bvSt.bvIslands.length,
      clLeft: cLeft,
      clRight: cRight,
      clDouble: cDouble,
      ce,
      path: pathPx,
      flags: playerFlags,
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
    won = false;
    hitIdx = -1;
    playerFlags = 0;
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
  onFace?.("smile"); // 起播复位笑脸
  setPlaying(true);
  onStats(buildStats()); // 起播即出面板（全 0 值），不等首帧
  return {
    restart() {
      setPlaying(false);
      resetReplay();
      onFace?.("smile");
      setPlaying(true);
      onStats(buildStats());
    },
    stop() {
      setPlaying(false);
      curEl.remove();
      /* 静态地图恢复：saved 类名回写 + 清内嵌 SVG（paintBombCell 的红雷） */
      for (let i = 0; i < N; i++) {
        const td = cellTd(i);
        if (td.className !== saved[i]) td.className = saved[i];
        if (td.innerHTML) td.innerHTML = "";
      }
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
      onFace?.("smile"); // seek 重置盘面：笑脸同步复位（快进中若过终局会再落 win/dead）
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

/* ---- 试玩终局成绩（二十期：全屏层「我的评级」的输入面） ----
   纯客观事实，不含任何评级折算：面板拿它 + 本录像所属的分位基准，走 lib/videoscore
   的共享件算出与录像评级同一口径的五轴点。 */
export interface PlayResult {
  /** 胜局（未完成＝踩雷） */
  won: boolean;
  /** 用时（百分秒） */
  csec: number;
  /** 已完成 3BV（与左侧数据面板 3BV 行的分母口径一致） */
  solvedBv: number;
  /** 全盘 3BV */
  board3bv: number;
  /** 总点击（左键 + 右键 + 双击） */
  cl: number;
  /** 有效点击（Ce = Cl − wasted） */
  ce: number;
  /** 鼠标行程（棋盘 1x 像素，mousemove 累加）——「我的评级」走位轴（3BV/PATH）用 */
  path: number;
}

/* ---- 试玩引擎（十七期：全屏层点笑脸后「自己玩本局」）----
   与在线练习 OnlinePlay 同一套交互口径（左开右旗 / chord / 按下态跟随 / 笑脸
   ooh↔smile / 终局 win·dead / LED 雷数计时），但盘面锁定为本录像的布雷
   （boardStr 反推雷区，无重排无猜救回），纯娱乐局：不录制事件流、不上传。
   返回 { destroy }：退出试玩（回到回放 / 退出全屏）时销毁监听并重置 DOM。 */
function runPlayGame(opts: {
  boardHost: HTMLElement; // .vprfs_board_wrap（试玩态光标隐藏、事件挂这里）
  tbody: HTMLTableSectionElement;
  rows: number;
  cols: number;
  data: ReplayData;
  onFace: (k: FaceKind | "press") => void;
  onStats: (s: ReplayStats) => void;
  /** 终局回调（二十期）：胜/负瞬间发一次，全屏层据此出「我的评级」 */
  onFinish: (r: PlayResult) => void;
  /** 模式开关即时值（二十一期：NF/速旗/连击，与练习页 online_play_settings 同一份；
      引擎每事件入口现读——React 切换即时生效，无需重建引擎（速旗/连击只改行为）。
      2026-10-29 增 leftDbl（左键双击，练习页同款独立开关；速旗收窄为仅右键） */
  getModes: () => { nf: boolean; quickFlag: boolean; combo: boolean; leftDbl: boolean; holdFlag: boolean; holdDelay: number };
  /** 级别（连击开局保护窗时长按级别：初级 0 / 中级 250ms / 高级 500ms，练习页同口径） */
  level: VideoLevel;
  /** NF 模式下右键被拦时的反馈（抖 NF 钮，练习页 shakeModeBtn 同款入口） */
  onNfBlocked?: () => void;
}): { destroy: () => void } {
  const { boardHost, tbody, rows, cols, data, onFace, onStats, onFinish, getModes, onNfBlocked, level } = opts;
  const N = rows * cols;
  const mines = new Uint8Array(N);
  const nums = new Uint8Array(N);
  let mineCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = data.board[i];
    if (ch === "*") {
      mines[i] = 1;
      mineCount++;
    } else nums[i] = ch.charCodeAt(0) - 48;
  }
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
  const bvSt = buildBvStructures(mines, nums, nbR);
  /* 3BV 与录像面板同一分母（试玩实时统计用） */
  const state = new Uint8Array(N); // 0 未开 / 1 开 / 2 旗 / 3 问号
  const cellTd = (i: number) => tbody.rows[(i / cols) | 0].cells[i % cols];
  function paint(i: number) {
    const td = cellTd(i);
    td.className = state[i] === 1 ? "b" + nums[i] : state[i] === 2 ? "bf" : state[i] === 3 ? "bq" : "bb";
    td.innerHTML = "";
  }
  /* 按下态（练习页 pressPaint 同款：平面下沉底 b0） */
  let pressCell: number | null = null;
  let chordCells: number[] | null = null;
  function pressPaint(c: number) {
    const td = cellTd(c);
    td.className = "b0";
    td.innerHTML = "";
  }
  function clearPress() {
    if (pressCell !== null && state[pressCell] === 0) paint(pressCell);
    pressCell = null;
    if (chordCells) {
      chordCells.forEach((c) => {
        if (state[c] === 0) paint(c);
      });
      chordCells = null;
    }
  }
  function pressSingle(i: number) {
    if (pressCell === i) return;
    if (pressCell !== null && state[pressCell] === 0) paint(pressCell);
    pressCell = i;
    if (state[i] === 0) pressPaint(i);
  }
  function pressAround(i: number) {
    if (chordCells) chordCells.forEach((c) => state[c] === 0 && paint(c));
    chordCells = nbR(i).concat([i]).filter((c) => state[c] === 0);
    chordCells.forEach(pressPaint);
  }
  /* ---- 计数条（练习页 led 同款：-99~999 钳制、负数两格） ---- */
  const ledEls = {
    mines: boardHost.closest(".gwrap")?.querySelectorAll<SVGElement>("#fs_led_mines use.d"),
    time: boardHost.closest(".gwrap")?.querySelectorAll<SVGElement>("#fs_led_time use.d"),
  };
  function led(kind: "mines" | "time", v: number) {
    const uses = ledEls[kind];
    if (!uses || uses.length < 3) return;
    v = Math.max(-99, Math.min(999, Math.round(v)));
    const a = Math.abs(v);
    const ds: (string | number)[] =
      v < 0 ? ["minus", ((a / 10) | 0) % 10, a % 10] : [((a / 100) | 0) % 10, ((a / 10) | 0) % 10, a % 10];
    for (let k = 0; k < 3; k++) uses[k].setAttribute("href", "#count-" + ds[k]);
  }
  function flagsLeft() {
    let f = 0;
    for (let i = 0; i < N; i++) if (state[i] === 2) f++;
    return mineCount - f;
  }
  /* ---- 对局状态 ---- */
  let started = false;
  let over = false;
  let openedSafe = 0;
  const totalSafe = N - mineCount;
  let curCsec = 0; // 首击起计时（练习页同款：百分秒）
  /* 连击开局保护（2026-10-24 与练习页 comboShield 同步）：原口径＝首击手势内
     滑动不开格（comboGuard）；练习页 2026-10-22 已改**时间窗内跳雷**——首格
     开出（openCell 起表）起保护窗内，连击滑动/按下路径上**安全格照常连开**，
     仅**有雷的格子被跳过**（无事件零动作）；窗口到期或开局手势松开（mouseup/
     touchend 置 comboGraceT0=0）后雷格照常触发。时长：初级 0（不设保护）/
     中级 250ms / 高级 500ms（试玩盘面锁定无自定义级别，exp 兜底） */
  let comboGraceT0 = 0;
  const COMBO_GRACE_MS = () => (level === "beg" ? 0 : level === "int" ? 250 : 500);
  /* 保护窗内＝连击开格要跳雷；未开局恒 false（首击即雷的锁定盘与练习页
     重玩本局同口径：保护只从首个安全格开出起算） */
  const comboShield = () => started && performance.now() - comboGraceT0 < COMBO_GRACE_MS();
  let timerId: number | null = null;
  let lastTick: number | null = null;
  /* 统计（练习页结算同源 ReplayCounts 口径的轻量子集——试玩实时面板） */
  let cLeft = 0,
    cRight = 0,
    cDouble = 0,
    wLeft = 0,
    wRight = 0,
    wDouble = 0;
  function buildStats(): ReplayStats {
    const { solvedBv, solvedOps, solvedIsls } = solvedScan(bvSt, (i) => state[i] === 1);
    let flags = 0;
    for (let i = 0; i < N; i++) if (state[i] === 2) flags++;
    const cl = cLeft + cRight + cDouble;
    const ce = cl - (wLeft + wRight + wDouble);
    return {
      csec: curCsec,
      /* 试玩没有「总长」概念：totalCsec 给 Est 折算一个非零基数（同录像长度，
         面板 RTime/Est 只显示不参与游戏逻辑） */
      totalCsec: data.totalCsec || 1,
      board3bv: bvSt.board3bv,
      totalMines: mineCount,
      solvedBv,
      solvedOps,
      totalOps: bvSt.bvRegions.length,
      solvedIsls,
      totalIsls: bvSt.bvIslands.length,
      clLeft: cLeft,
      clRight: cRight,
      clDouble: cDouble,
      ce,
      path: Math.round(playPathPx),
      flags,
    };
  }
  function emitStats() {
    onStats(buildStats());
  }
  /* 终局成绩快照（二十期）：判负/判胜各发一次。「已完成 3BV」走 buildStats 的
     solvedScan（空区/孤块按完成度算），不是「开格数」——与左侧面板 3BV 行同源 */
  function emitFinish(won: boolean) {
    const s = buildStats();
    onFinish({
      won,
      csec: s.csec,
      solvedBv: s.solvedBv,
      board3bv: s.board3bv,
      cl: cLeft + cRight + cDouble,
      ce: s.ce,
      path: s.path,
    });
  }
  function startTimer() {
    lastTick = null;
    timerId = window.setInterval(() => {
      const now = performance.now();
      if (lastTick !== null) curCsec = Math.min(99900, curCsec + (now - lastTick) / 10);
      lastTick = now;
      led("time", Math.floor(curCsec / 100));
      emitStats();
    }, 100);
  }
  function stopTimer() {
    if (timerId !== null) window.clearInterval(timerId);
    timerId = null;
  }
  function flood(i: number) {
    const stack = [i];
    while (stack.length) {
      const c = stack.pop()!;
      if (state[c] === 1 || state[c] === 2 || mines[c]) continue;
      state[c] = 1;
      openedSafe++;
      paint(c);
      if (nums[c] === 0) for (const a of nbR(c)) if (state[a] === 0) stack.push(a);
    }
  }
  function openCell(i: number) {
    if (over || state[i] === 1 || state[i] === 2) return;
    if (!started) {
      started = true;
      startTimer();
      comboGraceT0 = performance.now(); // 连击开局保护窗起点＝起表时刻（练习页同口径）
    }
    if (mines[i]) {
      lose(i);
      return;
    }
    flood(i);
    checkWin();
  }
  function chord(i: number) {
    if (over || state[i] !== 1 || nums[i] === 0) return;
    const around = nbR(i);
    let f = 0;
    for (const a of around) if (state[a] === 2) f++;
    if (f !== nums[i]) return;
    for (const a of around) {
      if (state[a] === 0) {
        openCell(a);
        if (over) return;
      }
    }
  }
  /* 速旗 chord 联动（二十一期，练习页 autoChordAround 同口径不录事件版）：
     插上旗后对周围已开数字格做 chord——预检「旗数满足且有未开非旗邻格」
     才执行；开不出格的空 chord 不做也不计数 */
  function quickChordAround(i: number) {
    for (const a of nbR(i)) {
      if (over || state[a] !== 1 || nums[a] === 0) continue;
      const around = nbR(a);
      let f = 0;
      for (const c of around) if (state[c] === 2) f++;
      if (f !== nums[a]) continue;
      if (!around.some((c) => state[c] === 0)) continue;
      cDouble++; // 有效 chord 计一次 Double（练习页 mr 引擎计 Double 同价）
      chord(a);
    }
  }
  function toggleFlag(i: number) {
    if (over || state[i] === 1) return;
    /* 问号三态跟随录像 marks（试玩延续本局文件口径） */
    if (state[i] === 0) state[i] = 2;
    else if (state[i] === 2) state[i] = data.marks ? 3 : 0;
    else state[i] = 0;
    paint(i);
    led("mines", flagsLeft());
  }
  /* 连击单格动作（二十一期，练习页 comboLeftClick/comboRightClick 同口径）：
     左＝未开格开 / 已开数字有效才 chord（滑过已开格零动作）；右＝未开格插旗 +
     速旗联动 / 已开数字（速旗开）有效才 chord；旗问号格不动作 */
  function comboLeft(i: number, slide = false) {
    if (over) return;
    if (state[i] === 1) {
      if (slide) return; // 滑过已开格：零动作（练习页四定）
      if (nums[i] === 0) return;
      const around = nbR(i);
      let f = 0;
      for (const c of around) if (state[c] === 2) f++;
      if (f !== nums[i] || !around.some((c) => state[c] === 0)) return;
      cDouble++;
      comboHit = true;
      chord(i);
    } else if (state[i] === 0) {
      /* 开局保护窗内跳雷（与练习页 comboLeftClick 同口径）：安全格照常开，
         仅有雷格被跳过（无事件零动作，玩家无感）；窗口到期后雷格照常触发 */
      if (comboShield() && mines[i]) return;
      comboHit = true;
      cLeft++;
      openCell(i);
    }
  }
  function comboRight(i: number) {
    if (over) return;
    const m = getModes();
    if (m.nf) return; // NF：右键禁用（入口已拦，双保险）
    if (m.quickFlag && state[i] === 1) {
      /* 连击右键在已开数字格（按下与滑动同口径，「有效才计」）：
         旗数恰好满足且有未开非旗邻格才 chord；否则静默跳过（slide 语义内置） */
      if (nums[i] === 0) return;
      const around = nbR(i);
      let f = 0;
      for (const c of around) if (state[c] === 2) f++;
      if (f !== nums[i] || !around.some((c) => state[c] === 0)) return;
      cDouble++;
      comboHit = true;
      chord(i);
      return;
    }
    if (state[i] !== 0) return; // 旗/问号格（含滑动经过）：不动作不误拔
    comboHit = true;
    cRight++;
    toggleFlag(i);
    /* toggleFlag 改过盘面，重读判定（TS 对 Uint8Array 元素的控制流窄化跨函数
       调用不失效——直接写 state[i] === 2 会被窄化成 0 恒 false 报 TS2367） */
    const st: number = state[i];
    if (m.quickFlag && st === 2) quickChordAround(i);
  }
  function lose(hit: number) {
    over = true;
    stopTimer();
    emitStats();
    for (let i = 0; i < N; i++) {
      if (mines[i] && state[i] !== 2 && state[i] !== 3) paintCellCls(cellTd(i), "bm");
      if (!mines[i] && state[i] === 2) paintCellCls(cellTd(i), "bn");
    }
    /* 被踩中的雷：红底雷（#cell-mine-bomb，与练习页踩雷同图；bc 位图是灰雷） */
    paintBombCell(cellTd(hit));
    onFace("dead");
    emitFinish(false); // 二十期：全屏层据此出「我的评级」
  }
  function checkWin() {
    if (openedSafe < totalSafe) return;
    over = true;
    stopTimer();
    emitStats();
    for (let i = 0; i < N; i++)
      if (mines[i] && state[i] !== 2) {
        state[i] = 2;
        paint(i);
      }
    led("mines", 0);
    onFace("win");
    emitFinish(true); // 二十期：全屏层据此出「我的评级」
  }
  function paintCellCls(td: HTMLTableCellElement, cls: string) {
    td.className = cls;
    td.innerHTML = "";
  }
  /* ---- 事件绑定（练习页 mousedown/mouseover/mouseup 口径 + 三模式） ---- */
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const boardDiv = boardHost.querySelector<HTMLElement>(".board")!;
  const on = <E extends Event>(
    el: Element | Window,
    type: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions
  ) => el.addEventListener(type, fn as EventListener, opts ? { ...sig, ...opts } : sig);
  on<MouseEvent>(boardDiv, "contextmenu", (e) => e.preventDefault());
  /* 试玩鼠标行程（2026-10-28）：mousemove 按棋盘 1x 像素累加欧氏距离——
     rect 已含 zoom，除以 (cols×16) 归一到 1x 口径，与录像引擎 pathPx 同量纲。
     「我的评级」走位轴（3BV/PATH）的数据源 */
  const playTable = boardDiv.querySelector("table") ?? (boardDiv.querySelector("tbody")?.parentElement as HTMLTableElement | null);
  let playPathPx = 0;
  let lastMX: number | null = null;
  let lastMY: number | null = null;
  on<MouseEvent>(boardDiv, "mousemove", (e) => {
    const table = playTable;
    if (!table) return;
    const rect = table.getBoundingClientRect();
    if (!rect.width) return;
    const scale = rect.width / (cols * 16);
    const mx = (e.clientX - rect.left) / scale;
    const my = (e.clientY - rect.top) / scale;
    if (lastMX !== null && lastMY !== null) playPathPx += Math.hypot(mx - lastMX, my - lastMY);
    lastMX = mx;
    lastMY = my;
  });
  const eventCell = (e: { target: EventTarget | null }): number => {
    const td = (e.target as HTMLElement).closest("td");
    if (!td || !tbody.contains(td)) return -1;
    return (td.parentNode as HTMLTableRowElement).rowIndex * cols + td.cellIndex;
  };
  let leftDown = false,
    rightDown = false,
    chordDone = false;
  /* 连击手势标记（练习页同款）：comboHit＝本次按下已产生过动作（松开拔旗只放行
     空手松开）。开局保护窗改时间窗跳雷（comboShield，见对局状态区），不再有
     手势级闸门 */
  let comboHit = false;
  on<MouseEvent>(boardDiv, "mousedown", (e) => {
    if (over) return;
    const i = eventCell(e);
    if (i < 0) return;
    const m = getModes();
    /* 连击模式按下即触发（练习页同款）：左＝完整一次点击、右＝完整一次右击，
       按住滑动逐格连点（见 mouseover），松开只复位（拔旗例外，见 mouseup） */
    if (m.combo && e.button === 0) {
      leftDown = true;
      rightDown = false;
      chordDone = false;
      comboHit = false;
      onFace("ooh");
      comboLeft(i); // 按下即触发（开局保护窗内雷格由 comboLeft 内部跳过）
      return;
    }
    if (m.combo && e.button === 2) {
      if (m.nf) {
        onNfBlocked?.();
        return;
      }
      rightDown = true;
      leftDown = false;
      chordDone = false;
      comboHit = false;
      onFace("ooh");
      comboRight(i);
      return;
    }
    if (e.buttons === 3) {
      clearPress();
      pressAround(i);
      onFace("ooh");
      if (e.button === 2) rightDown = true;
      else leftDown = true;
    } else if (e.button === 0) {
      leftDown = true;
      rightDown = false;
      chordDone = false;
      pressSingle(i);
      onFace("ooh");
    } else if (e.button === 2) {
      if (m.nf) {
        // NF 模式：右键禁用（练习页口径——只抖 NF 钮反馈，无动作）
        onNfBlocked?.();
        return;
      }
      rightDown = true;
      leftDown = false;
      chordDone = false;
      cRight++;
      /* 速旗开＋点已开数字＝双击（练习页 flagWithAutoChord 口径）；否则插旗，
         插上后速旗联动 quickChordAround */
      if (m.quickFlag && state[i] === 1) {
        cRight--; // 双击口径：不计右键，计 Double
        cDouble++;
        const before = openedSafe;
        chord(i);
        if (openedSafe === before && state[i] === 1) {
          /* 预检不满足（旗数未满足/无可开格）＝走位失误：练习页不录不计——
             这里回退计数（wasted 口径与练习页「有效才计」一致） */
          cDouble--;
          cRight++;
          wRight++;
        }
      } else {
        toggleFlag(i); // 插旗即刻生效（练习页 rc 口径）；无效右键（已开格上）进 wasted
        if (m.quickFlag && state[i] === 2) quickChordAround(i);
        if (state[i] === 1) wRight++;
      }
    }
  });
  on<MouseEvent>(boardDiv, "mouseover", (e) => {
    if (over) return;
    if (e.buttons === 0 && (leftDown || rightDown)) leftDown = rightDown = chordDone = false;
    const i = eventCell(e);
    if (i < 0) return;
    const m = getModes();
    /* 连击滑动连点（练习页同款）：按住左键滑过未开格即开（开局保护窗内雷格
       在 comboLeft 内部跳过）、只按右键滑过未开格即插旗；无需按下态高亮（动作瞬时完成） */
    if (m.combo) {
      if (leftDown) {
        onFace("ooh");
        comboLeft(i, true);
      } else if (rightDown) {
        onFace("ooh");
        comboRight(i);
      }
      return;
    }
    if (e.buttons === 3) {
      if (pressCell !== null) {
        if (state[pressCell] === 0) paint(pressCell);
        pressCell = null;
      }
      pressAround(i);
      onFace("ooh");
    } else if (e.buttons === 1) {
      if (chordCells) {
        chordCells.forEach((c) => state[c] === 0 && paint(c));
        chordCells = null;
      }
      pressSingle(i);
      onFace("ooh");
    }
  });
  on<MouseEvent>(window, "mouseup", (e) => {
    if (!leftDown && !rightDown) return;
    if (over) {
      clearPress();
      leftDown = rightDown = chordDone = false;
      return;
    }
    const i = eventCell(e);
    const m = getModes();
    /* 连击松开＝纯复位（练习页同款）：配对在按下/滑过触发时已闭合。
       例外＝松开拔旗：右键在旗格上松开＝取消标记，仅空手松开放行
       （comboHit 守卫：按下插过旗不拔自己的旗） */
    if (m.combo) {
      const ui = rightDown ? i : -1;
      if (ui >= 0 && !comboHit && !m.nf && state[ui] === 2) {
        cRight++;
        state[ui] = 0;
        paint(ui);
        led("mines", flagsLeft());
        cRight--; // 拔旗不计右键（练习页松开拔旗录 rc+rr 但引擎 rr 不计右键；对齐计数）
      }
      clearPress();
      onFace("smile");
      comboGraceT0 = 0; // 开局保护随开局手势松开即刻终止（练习页 mouseup 同口径）
      leftDown = rightDown = chordDone = false;
      if (started && !over) emitStats();
      return;
    }
    clearPress();
    onFace("smile");
    if (e.button === 0) {
      if (rightDown && !chordDone) {
        chordDone = true;
        cDouble++;
        const ok = ((): boolean => {
          if (i < 0) return false;
          const before = openedSafe;
          chord(i);
          return openedSafe > before || state[i] === 1;
        })();
        if (!ok) wDouble++;
      } else if (chordDone) {
        /* 尾随松开：只闭合手势 */
      } else if (m.leftDbl && i >= 0 && state[i] === 1) {
        /* 左键单击已开数字格＝双击：「左键双击」模式专属（2026-10-29 练习页口径
           同步——从速旗移交独立开关，速旗收窄为仅右键；关掉后点数字格零动作，
           落 else 计左键 wasted，openCell 已开格守卫吞掉） */
        cDouble++;
        const before = openedSafe;
        chord(i);
        if (openedSafe === before) wDouble++;
      } else {
        cLeft++;
        if (i >= 0) openCell(i);
        else wLeft++;
      }
      leftDown = false;
    } else if (e.button === 2) {
      if (leftDown && !chordDone) {
        /* 按住左键连点右键＝连续 chord（2026-10-18 练习页口径，二十一期同步到
           试玩引擎）：每次右键松开都触发，不再只第一次 */
        chordDone = true;
        cDouble++;
        const before = openedSafe;
        if (i >= 0) chord(i);
        if (openedSafe === before) wDouble++;
      } else if (leftDown && chordDone) {
        /* 尾随松开：只闭合手势 */
      } else {
        /* rr 闭合（插旗在 mousedown 已生效，练习页 AVF 配对口径） */
      }
      rightDown = false;
    }
    if (!leftDown && !rightDown) chordDone = false;
    if (started && !over) emitStats();
  });
  on<MouseEvent>(boardDiv, "mouseleave", () => {
    clearPress();
    if (!over) onFace("smile");
  });
  /* 触屏（练习页口径：点按开格 / 长按 ≥150ms 插旗；超容差滑动取消；
      连击开＝滑动沿轨迹连开（半格步长插值防跳格），长按插旗保留不受影响） */
  let touchTimer: number | null = null,
    touchCell = -1,
    longFired = false,
    tX = 0,
    tY = 0;
  /* 连击触屏轨迹采样（练习页同款）：上一采样点（棋盘 1x 像素）+ 已滑动标记 */
  let touchMoved = false,
    touchLastX = 0,
    touchLastY = 0;
  /* 触点屏幕坐标 → 棋盘 1x 像素（touch target 恒为起始格，滑动须按坐标算格；
      渲染尺寸÷格子总数＝单格渲染尺寸，client 偏移÷单格＝1x 像素域坐标——
      不依赖 --vfz 读取，zoom 域变化自动适应） */
  const touchBoardPx = (cx: number, cy: number) => {
    const br = boardDiv.getBoundingClientRect();
    return {
      x: ((cx - br.left) / br.width) * cols * 16,
      y: ((cy - br.top) / br.height) * rows * 16,
    };
  };
  on<TouchEvent>(boardDiv, "touchstart", (e) => {
    if (over || e.touches.length !== 1) return;
    const i = eventCell(e);
    if (i < 0) return;
    touchCell = i;
    longFired = false;
    touchMoved = false;
    tX = e.touches[0].clientX;
    tY = e.touches[0].clientY;
    const bp0 = touchBoardPx(tX, tY);
    touchLastX = bp0.x;
    touchLastY = bp0.y;
    onFace("ooh");
    /* 连击开：触点不即开（让位长按插旗），点按在 touchend 开、滑动在 touchmove 连开。
       长按标雷（2026-10-29 练习页口径同步）：m.holdFlag 关＝长按零动作不挂定时器，
       时长＝m.holdDelay（100-400ms） */
    if (getModes().combo) return;
    if (!getModes().holdFlag) {
      touchTimer = null;
      return;
    }
    touchTimer = window.setTimeout(() => {
      if (over || touchCell < 0) return;
      const m = getModes();
      if (m.nf) {
        onNfBlocked?.();
        return;
      }
      longFired = true;
      cRight++;
      toggleFlag(touchCell);
      pressPaint(touchCell);
      if (m.quickFlag && state[touchCell] === 2) quickChordAround(touchCell);
    }, getModes().holdDelay);
  });
  on<TouchEvent>(boardDiv, "touchmove", (e) => {
    const t = e.changedTouches[0];
    if (!t || touchCell < 0) return;
    if (getModes().combo) {
      /* 连击滑动连开（练习页同款）：容差内不算滑动（保长按插旗）；超容差沿轨迹
         半格步长插值逐格开（快滑跳格防漏）；起始格在此补开（touchstart 不即开，
         开局保护窗内雷格由 comboLeft 内部跳过） */
      if (Math.hypot(t.clientX - tX, t.clientY - tY) <= 12) return;
      if (touchTimer) {
        window.clearTimeout(touchTimer);
        touchTimer = null;
      }
      if (over) {
        touchCell = -1;
        return;
      }
      touchMoved = true;
      /* 起始格补开（touchstart 不即开，这里是首击唯一入口）＋沿轨迹插值逐格开——
         开局保护窗内的跳雷收在 comboLeft 内部（无事件零动作），不再有手势级
         闸门（2026-10-24 与练习页同步） */
      if (state[touchCell] === 0) comboLeft(touchCell);
      {
        const bp = touchBoardPx(t.clientX, t.clientY);
        const steps = Math.max(1, Math.ceil(Math.hypot(bp.x - touchLastX, bp.y - touchLastY) / 8));
        for (let s = 1; s <= steps; s++) {
          const px = touchLastX + ((bp.x - touchLastX) * s) / steps;
          const py = touchLastY + ((bp.y - touchLastY) * s) / steps;
          const cx = (px / 16) | 0,
            cy = (py / 16) | 0;
          if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
          const i = cy * cols + cx;
          if (state[i] === 0 && i !== touchCell) {
            touchCell = i;
            comboLeft(i);
          }
        }
        touchLastX = bp.x;
        touchLastY = bp.y;
      }
      return;
    }
    if (Math.hypot(t.clientX - tX, t.clientY - tY) > 12) {
      if (touchTimer) window.clearTimeout(touchTimer);
      touchTimer = null;
      touchCell = -1;
      if (!over) onFace("smile");
    }
  }, { passive: true });
  on<TouchEvent>(boardDiv, "touchend", (e) => {
    if (touchTimer) window.clearTimeout(touchTimer);
    touchTimer = null;
    onFace("smile");
    if (getModes().combo) {
      /* 连击触屏：点按在松开开格（touchstart 未即开）；滑动已在 touchmove 完成 */
      if (over || touchCell < 0) {
        touchCell = -1;
        longFired = false;
        touchMoved = false;
        return;
      }
      const i = touchCell;
      touchCell = -1;
      const moved = touchMoved;
      touchMoved = false;
      comboGraceT0 = 0; // 开局保护随抬起即刻终止（练习页 touchend 同口径）
      e.preventDefault();
      if (!moved && !longFired) comboLeft(i);
      if (started && !over) emitStats();
      return;
    }
    if (over || longFired || touchCell < 0) {
      touchCell = -1;
      longFired = false;
      return;
    }
    const i = touchCell;
    touchCell = -1;
    e.preventDefault(); // 防 touch 后合成 click 再开一格
    cLeft++;
    openCell(i);
    if (started && !over) emitStats();
  });
  /* 初始计数条 + 面板 + 全盘重置（进入/重开都从全未开的干净盘面起步——
     上局试玩或回放镜像残留的类名全部刷回 bb） */
  for (let i = 0; i < N; i++) {
    state[i] = 0;
    paint(i);
  }
  led("mines", flagsLeft());
  led("time", 0);
  emitStats();
  return {
    destroy() {
      ac.abort();
      stopTimer();
      clearPress();
    },
  };
}

/* ---- React 外壳：Provider（引擎/缓存/flop 兜底）+ Board + Panel + Bar + Button ---- */

/* 2026-10-22 导出 Status：后台审核播放器（AdminVideoPlayer）standalone 模式
 *  需要以同一状态机驱动 ReplayFullscreen 的控制条 */
export type Status = "idle" | "loading" | "playing" | "paused" | "ended";

interface ReplayCtxValue {
  status: Status;
  stats: ReplayStats | null;
  fullscreen: boolean;
  play: () => void;
  /** 一键全屏试玩（二十一期）：等价于「点全屏按钮 + 点笑脸」两步 */
  playGame: () => void;
  /** 弹旧版（flop）播放器播放本录像（2026-10-21 张老师需求：大按钮 hover 气泡入口） */
  playLegacy: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** 播放/暂停切换（控制条按钮）；ended 态＝从头重播 */
  togglePlay: () => void;
  /** 跳转到指定百分秒（引擎重置盘面后快进，统计随发） */
  seek: (csec: number) => void;
  /** 进入/退出全屏回放层 */
  setFullscreen: (v: boolean) => void;
}

const ReplayCtx = createContext<ReplayCtxValue | null>(null);

/* fetch 非 2xx（404/5xx 等）专用错误：拉不到文件时 flop 播放器拉同一 URL
   也必失败，不再走 flop 兜底，改气泡提示（见 play() catch 分支） */
class FetchError extends Error {
  status: number;
  constructor(status: number) {
    super(`fetch ${status}`);
    this.status = status;
  }
}

export function VideoReplayProvider({
  boardId,
  filepath,
  realTimeMs,
  radarPoints,
  radarOverall,
  radarDists,
  level,
  noflag,
  boardStr,
  children,
}: {
  /** Board 组件渲染的 id="board_{boardId}"，play() 时据此定位棋盘 DOM */
  boardId: number;
  filepath: string;
  /** 库内权威用时（毫秒，video_info.real_time）：进度条总长与播放终点以库为准 */
  realTimeMs?: number;
  /** 服务端算好的本局五轴雷达数据（详情页右栏同源）——全屏层右侧「录像评级」用
   *  （十九期恢复，2026-10-16 张老师定） */
  radarPoints?: VideoAnalysisPoint[];
  /** 综合评级字母（analysis.overall，同右栏口径） */
  radarOverall?: string;
  /** 本录像所属组（级别 × 模式）的分位基准边界——全屏试玩结束时的「我的评级」
   *  用同一组给玩家本局打分（二十期，2026-10-16） */
  radarDists?: Partial<Record<MetricKey, number[]>>;
  /** 打法（2026-10-28）：「我的评级」效率轴按组选指标（NF=IOE / FL=ThrP）需知 noflag */
  noflag?: boolean;
  /** 级别与整盘串（renderBoard 后 '*'/数字）——全屏层重画 Board 用 */
  level?: VideoLevel;
  boardStr?: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [stats, setStats] = useState<ReplayStats | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /* 笑脸状态（十七期）：回放引擎 onFace 直通——全屏层计数条消费；
     页面态无消费者不渲染，state 变更开销可忽略（每事件至多一次） */
  const [face, setFace] = useState<FaceKind>("smile");
  /* 解析产物镜像（十七期）：dataRef 的渲染期可读副本——全屏层试玩引擎数据源 */
  const [replayData, setReplayData] = useState<ReplayData | null>(null);
  /* 播放失败气泡（2026-10-16）：文件 404/网络失败等场景，棋盘中央红字提示，
     3.5s 自动消失；再点播放重试（dataRef 已置 null 会重新 fetch） */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const notify = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    []
  );
  /* 移动端横屏贴合（2026-10-28 张老师需求）：本页切到横屏时滚动屏幕让棋盘贴顶
     （站头已在 CSS 改随页滚走，globals.css 移动横屏 :has(#video_view) 组）。
     旋转后布局/页级 zoom 异步收敛，rAF + 350ms 兜底各滚一次；滚动量按棋盘视口
     顶差值现算（幂等：已贴顶时差值 0 不再滚），横竖屏来回切只有进横屏才动作 */
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse) and (orientation: landscape)");
    const onLs = () => {
      if (!mq.matches) return;
      const scrollFlush = () => {
        const board = document.querySelector<HTMLElement>("#video_view .play_board");
        if (!board) return;
        const top = board.getBoundingClientRect().top;
        if (top > 1) window.scrollBy(0, top);
      };
      requestAnimationFrame(scrollFlush);
      window.setTimeout(scrollFlush, 350);
    };
    mq.addEventListener("change", onLs);
    return () => mq.removeEventListener("change", onLs);
  }, []);
  /* flop 兜底（rmv / 解析失败）：FlopPlayer 懒挂，挂上后再 playFlop。
     子组件 effect 先于本组件 effect 执行 → 届时 window.flop 已建好；
     播放器 iframe 未就绪时 playFlop 的 pendingUri 队列自动兜底 */
  const [flopUri, setFlopUri] = useState<string | null>(null);
  /* undefined＝未加载；null＝试过但失败（后续直接走 flop，不重复拉取） */
  const dataRef = useRef<ReplayData | null | undefined>(undefined);
  const engineRef = useRef<Engine | null>(null);
  /* 起播请求在途标记（二十一期：startEngine 防抖，见其注释） */
  const loadingRef = useRef(false);

  const uri = `/videos${filepath}`;

  useEffect(() => {
    if (flopUri && window.flop) playFlop(flopUri);
  }, [flopUri]);

  /* 起播核心（二十一期从 play() 抽出，play/playGame 共用）：完成 fetch+parse+
     页面回放引擎启动。返回 true＝引擎就绪（试玩数据源 replayData 已落 state）；
     false＝flop 兜底或加载失败（播放失败气泡 / flop 播放器由本函数内部负责，
     调用方按返回值决定后续，勿再自动进全屏）。 */
  const startEngine = useCallback(async (): Promise<boolean> => {
    /* 回放中/已结束再点＝从头重播（练习页六期口径） */
    if (engineRef.current) {
      engineRef.current.restart();
      setStatus("playing");
      return true;
    }
    /* 请求在途防抖（按钮 disabled 是渲染层，双击同拍竞态在此兜底：
       连续两次 runReplay 会双挂光标 div、双份 rAF——必须挡住） */
    if (loadingRef.current) return false;
    const boardEl = document.getElementById(`board_${boardId}`);
    const wrap = (boardEl?.closest(".play_board") as HTMLElement | null) ?? null;
    const tbody = boardEl?.querySelector("tbody");
    if (!wrap || !tbody) return false;
    const rows = (tbody as HTMLTableSectionElement).rows.length;
    const cols = rows ? (tbody as HTMLTableSectionElement).rows[0].cells.length : 0;
    if (!rows || !cols) return false;
    const ext = (filepath.split(".").pop() || "").toLowerCase();
    if (ext !== "avf" && ext !== "mvf" && ext !== "rmv" && ext !== "evf") {
      // rmf 等站内无解析器的格式 → flop 播放器兜底
      setFlopUri(uri);
      return false;
    }
    loadingRef.current = true;
    setStatus("loading");
    try {
      if (dataRef.current === undefined) {
        const res = await fetch(uri);
        if (!res.ok) throw new FetchError(res.status);
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
        return false;
      }
      /* 极端并发（加载完成与用户二次点击同拍）：已有引擎就重播，不双开。
         ⚠️ as 断言不可省：顶部 guard 后 TS 把 engineRef.current 收窄为 null
         且跨 await 不失效（TS 不跟踪异步交错），此处真值分支会被推成 never */
      const eng = engineRef.current as Engine | null;
      if (eng) {
        eng.restart();
        setStatus("playing");
        return true;
      }
      engineRef.current = runReplay({
        wrap,
        tbody: tbody as HTMLTableSectionElement,
        rows,
        cols,
        data,
        onEnd: () => setStatus("ended"),
        onStats: setStats,
        onFace: setFace,
      });
      /* 解析产物留 state 一份：全屏层试玩引擎的布雷数据源（渲染期可读） */
      setReplayData(data);
      setStatus("playing");
      return true;
    } catch (e) {
      dataRef.current = null;
      /* 文件拉不到（404/5xx/网络断）：flop 播放器拉同一 URL 也必失败——
         不再弹全屏播放器，改棋盘中央红色气泡提示（2026-10-16 张老师需求：
         录像文件缺失可能是历史屏蔽误删，改判后可恢复，播放失败要能看懂原因） */
      if (e instanceof FetchError) {
        setStatus("idle");
        notify(`录像文件加载失败（${e.status || "网络错误"}），无法播放`);
        return false;
      }
      setStatus("idle");
      setFlopUri(uri);
      return false;
    } finally {
      loadingRef.current = false;
    }
  }, [boardId, filepath, realTimeMs, uri, notify]);

  const play = useCallback(() => {
    void startEngine();
  }, [startEngine]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    setStats(null);
    setStatus("idle");
    setFace("smile");
    setReplayData(null);
  }, []);

  /* 一键全屏试玩（二十一期，2026-10-21 张老师需求）：等价于依次点
     「播放→全屏→笑脸」三步直达。起播核心 await 成功后进全屏 + 置 autoPlay
     flag（ReplayFullscreen 挂载后自动「点笑脸」进试玩，见其 autoEnterPlay
     effect）；失败（fetch 404 / flop 兜底）不自开全屏——播放失败气泡与
     flop 播放器由 startEngine 内部负责，本函数只按返回值决定后续。 */
  const [autoPlay, setAutoPlay] = useState(false);
  const statusRef = useRef<Status>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const playGame = useCallback(() => {
    if (statusRef.current === "loading") return; // 加载中重复点：忽略（防双 fetch）
    /* 预检：不支持原地解析的格式（rmv / rmf 等）没有锁盘试玩能力（走 flop
       播放器兜底，无布雷数据）——直接提示，不进全屏 */
    const ext = (filepath.split(".").pop() || "").toLowerCase();
    if (ext !== "avf" && ext !== "mvf" && ext !== "evf") {
      notify("该录像格式不支持试玩（仅 avf / mvf / evf）");
      return;
    }
    void (async () => {
      if (!(await startEngine())) return;
      setFullscreen(true);
      setAutoPlay(true);
    })();
  }, [startEngine, filepath, notify]);

  /* 旧版播放器（2026-10-21 张老师需求）：大播放按钮 hover 气泡里的入口——
     复用 Provider 现成的 flop 懒挂链路（rmv 兜底同款）：setFlopUri(uri) 挂
     FlopPlayer iframe，挂上后 effect 调 playFlop 弹全屏 flop 播放器；
     播放器未就绪时 playFlop 的 pendingUri 队列自动补播，多次点击幂等 */
  const playLegacy = useCallback(() => {
    // 已挂载的播放器必须每次都直接起播：flopUri 不变时 setState 不会触发
    // 上面的 effect，否则同一录像关闭后无法再次进入。
    if (window.flop) playFlop(uri);
    else setFlopUri(uri);
  }, [uri]);

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

  const seek = useCallback(
    (csec: number) => {
      const engine = engineRef.current;
      if (!engine || !stats) return;
      engine.seek(csec);
      /* 拖到终点＝ended 态（定格终局，播放按钮语义与自然播完一致＝重播） */
      setStatus(csec >= stats.totalCsec ? "ended" : "paused");
    },
    [stats]
  );

  /* Esc（练习页同款出口之一）：全屏态 Esc＝只退出全屏（回放继续）；
     页面态 Esc＝退出回放。fullscreenRef 供 stop 前读取最新值（回调闭包新鲜化） */
  const fullscreenRef = useRef(false);
  useEffect(() => {
    fullscreenRef.current = fullscreen;
  }, [fullscreen]);
  useEffect(() => {
    if (status === "idle") return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (fullscreenRef.current) setFullscreen(false);
      else stop();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [status, stop]);

  /* 退出回放时同步收起全屏层（stop 全路径出口：Esc/点棋盘/重播按钮均安全） */
  const stopAll = useCallback(() => {
    setFullscreen(false);
    stop();
  }, [stop]);

  /* 一键试玩 flag 回收（二十一期）：stabilized 回调，供 ReplayFullscreen
     的一次性触发 effect 引用 */
  const autoEnterDone = useCallback(() => setAutoPlay(false), []);

  /* 卸载清理（软导航离开页面时停引擎、恢复/释放 DOM） */
  useEffect(
    () => () => {
      engineRef.current?.stop();
      engineRef.current = null;
    },
    []
  );

  return (
    <ReplayCtx.Provider
      value={{
        status,
        stats,
        fullscreen,
        play,
        playGame,
        playLegacy,
        stop: stopAll,
        pause,
        resume,
        togglePlay,
        seek,
        setFullscreen,
      }}
    >
      {children}
      {/* 光标贴图定义（隐藏 svg defs，含 #cursor-arrow） */}
      <FlopSprites />
      {flopUri && <FlopPlayer />}
      {/* 播放失败提示（2026-10-16）：棋盘中央红色气泡（文件 404 等场景，
          flop 播放器拉同一 URL 也必失败，不再弹全屏播放器） */}
      {notice && <div className="replay_notice" role="alert">{notice}</div>}
      {/* 全屏回放层（十期）：遮罩 + 自适应布局，点遮罩退出。
          十七期：复用练习页游戏界面（银框+计数条+笑脸），撤右栏评级；
          引擎启动时若已全屏，直接以全屏棋盘为宿主 */}
      {fullscreen && level && boardStr && (
        <ReplayFullscreen
          level={level}
          boardId={boardId}
          boardStr={boardStr}
          stats={stats}
          status={status}
          replayData={replayData}
          engineFace={face}
          radarPoints={radarPoints}
          radarOverall={radarOverall}
          radarDists={radarDists}
          noflag={noflag}
          autoEnterPlay={autoPlay}
          onAutoEnterDone={autoEnterDone}
          onToggle={togglePlay}
          onPause={pause}
          onSeek={seek}
          onResume={resume}
          onExit={() => setFullscreen(false)}
        />
      )}
    </ReplayCtx.Provider>
  );
}

/** 数据统计面板内容（十期拆出）：行集/口径/气泡＝练习页 statsReport 同款，
 *  行值派生公式勿改。页面模式与全屏层共用。 */
function ReplayStatsTable({ level, s }: { level: VideoLevel; s: ReplayStats }) {
  const t = s.csec / 100;
  const f3 = (v: number) => v.toFixed(3);
  const hasBv = s.solvedBv > 0 && t > 0;
  const est = hasBv ? t * (s.board3bv / s.solvedBv) : 0;
  const qg = hasBv ? Math.pow(t, 1.7) / s.solvedBv : 0;
  /* STNB 难度系数（标准级别；公式与练习页 statsReport / lib/videoradar stnbOf 同式） */
  const ln = level === "beg" ? 1 : level === "int" ? 2 : 3;
  const stnb = hasBv
    ? ((73.5 * ln * ln - 94.5 * ln + 57) / qg) * Math.sqrt(s.solvedBv / s.board3bv)
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
    ["STNB", hasBv ? f3(stnb) : "*", "综合评分（按难度与完成度归一化，越大越好）"],
  ];
  return (
    <>
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
    </>
  );
}

/** 页面态数据面板（九期；十期 portal 化）：挂 body 直下（.video_cell 的 legacy
 *  overflow:hidden 会把盒内绝对定位子元素整块裁掉——面板伸到盒外必被裁，
 *  实测 elementFromPoint 落在 BODY 上，与 #gr_modal 挂 body 的既有教训同源）。
 *  JS 定位：锚 .play_board 左缘外 14px、top 与棋盘顶对齐；
 *  宽高自适应（练习页 syncReportZoom 同思路）inline zoom 封顶，下限 0.3。
 *  2026-10-28 张老师需求：移动端横屏左侧空间不足时面板改锚棋盘【右侧】
 *  （左侧硬塞小字号不可读、真机定位漂移时还会盖住棋盘）；右侧也放不下才隐藏 */
function ReplayStatsPanel({ level, s }: { level: VideoLevel; s: ReplayStats }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const wrap = document.querySelector<HTMLElement>("#video_view .play_board");
      if (!wrap) return;
      const wr = wrap.getBoundingClientRect();
      el.style.zoom = "1";
      el.style.display = "";
      const pr = el.getBoundingClientRect();
      if (pr.width < 1 || pr.height < 1) return;
      /* 定位：面板贴棋盘左缘 −14px（左锚）或棋盘右缘 +14px（右锚）、顶边对齐棋盘顶。
         absolute（2026-10-17 定：随页滚动、与棋盘保持位置关系，不用 fixed）→
         文档坐标 = 视口坐标 + scrollX/Y。
         zoom 语义：CSS left/top 会随 zoom 同步缩放 → 换算成 CSS 值要除回 z；
         宽度在 CSS 域是自然宽 pr.width（不随 left 换算走）——
         即左锚 CSS left = (wr.left − gap)/z − pr.width（首版把自然宽也除了 z，
         z<1 时面板向左飞出屏，1920 因 z=1 蒙混过关） */
      const hostRect = wrap.closest(".playable")?.getBoundingClientRect();
      const hostH = hostRect ? hostRect.height : wr.height;
      const gap = 14;
      const zH = hostH > 1 ? hostH / pr.height : 1;
      /* 十九期张老师定：页面态（未全屏）面板放大 1.25 倍——先按既有约束取 fit
         （宽不重叠棋盘、高不高于「棋盘+控制条」整块），再整体 ×1.25；
         放大后横向仍不得与棋盘重叠，纵向允许向棋盘下方延伸（面板不是棋盘的一部分）。 */
      const zCap = Math.min(1, zH) * 1.25;
      /* 侧别判定（2026-10-28 张老师需求）：移动端横屏（coarse+landscape）一律右锚
         ——左侧空间小，硬塞会盖棋盘/字号不可读；其余维持左锚，左侧 <0.5x
         （字号 13px×0.5 不可读的下限，宁缺毋滥）时右侧兜底，两侧都放不下才隐藏 */
      const zW = (wr.left - gap - 12) / pr.width;
      const zR = (window.innerWidth - wr.right - gap - 12) / pr.width;
      const coarseLandscape = window.matchMedia(
        "(pointer: coarse) and (orientation: landscape)"
      ).matches;
      const useRight = coarseLandscape ? zR >= 0.5 : zW < 0.5 && zR >= 0.5;
      let z: number;
      let docLeft: number; // 面板视觉左缘（文档坐标）→ CSS left = docLeft / z
      if (useRight) {
        z = Math.max(0.3, Math.min(zR, zCap));
        docLeft = wr.right + window.scrollX + gap;
      } else {
        if (zW < 0.5) {
          el.style.display = "none";
          return;
        }
        z = Math.max(0.3, Math.min(zW, zCap));
        /* 视觉宽 = pr.width × z（不随 left 换算走）——左锚视觉左缘 =
           棋盘左缘 − gap − 面板视觉宽（首版把自然宽也除了 z，
           z<1 时面板向左飞出屏，1920 因 z=1 蒙混过关） */
        docLeft = wr.left + window.scrollX - gap - pr.width * z;
      }
      el.style.zoom = String(z);
      el.style.left = docLeft / z + "px";
      el.style.top = (wr.top + window.scrollY) / z + "px";
    };
    /* 定位失效兜底（2026-10-28）：此前只挂 window resize——真机上棋盘/其上方
       内容（封面图、标题区）异步就绪会改变棋盘文档位置，回放中统计值变化也
       会改面板自然宽，均不触发 resize → 面板按过期坐标漂移、盖住棋盘。
       rAF 合帧后统一重算。 */
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const stage = document.querySelector("#video_view");
    if (stage) ro.observe(stage);
    return () => {
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="replay_panel" ref={ref}>
      <ReplayStatsTable level={level} s={s} />
    </div>,
    document.body
  );
}

/** 控制条（九期；十期改版）：暂停/播放 + 全屏按钮 + 可拖拽进度条，
 *  拖拽：按住即暂停（记住原播放态），拖动中按帧 seek 实时预览，松手定位——
 *  拖前在播则松手续播；点轨道任意位置＝单次跳转（同语义）。
 *  当前时间＝站绿 #a6e22e（十期张老师定）；总时间已去（标题上有）。 */
function ReplayBar({
  status,
  stats,
  onToggle,
  onPause,
  onSeek,
  onResume,
  onFullscreen,
  fsActive = false,
}: {
  status: Status;
  stats: ReplayStats;
  onToggle: () => void;
  onPause: () => void;
  onSeek: (csec: number) => void;
  onResume: () => void;
  /** 全屏按钮回调（页面态＝进全屏；全屏层内＝退出全屏继续播放） */
  onFullscreen?: () => void;
  /** 全屏态：按钮高亮、title 变「退出全屏」 */
  fsActive?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, wasPlaying: false, raf: 0, lastCsec: 0 });
  const total = stats.totalCsec;
  const pct = total > 0 ? Math.max(0, Math.min(1, stats.csec / total)) : 0;
  const posToCsec = (clientX: number) => {
    /* 轨道内衬即 .rb_rail（thumb/fill 都锚在 rail 里）：直接用 rail rect 折算，
       100% 时 thumb 中心在 rail 右缘、半宽不出轨道（修尾部溢出） */
    const rail = trackRef.current?.querySelector<HTMLElement>(".rb_rail");
    if (!rail || total <= 0) return 0;
    const r = rail.getBoundingClientRect();
    const ratio = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
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
        onClick={(e) => {
          e.stopPropagation(); /* 按钮在 .play_board 内，不冒泡到「点棋盘退出」 */
          onToggle();
        }}
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
      {onFullscreen && (
        <button
          type="button"
          className={"rb_btn" + (fsActive ? " active" : "")}
          title={fsActive ? "退出全屏" : "全屏播放"}
          aria-label={fsActive ? "退出全屏" : "全屏播放"}
          onClick={(e) => {
            e.stopPropagation(); /* 同上：不冒泡到棋盘退出 */
            onFullscreen();
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {fsActive ? (
              /* 退出态：四角向内收（收缩箭头语义） */
              <>
                <path d="M5 8V5h3" />
                <path d="M19 8V5h-3" />
                <path d="M5 16v3h3" />
                <path d="M19 16v3h-3" />
              </>
            ) : (
              <>
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </>
            )}
          </svg>
        </button>
      )}
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
          const csec = posToCsec(e.clientX);
          onSeek(csec);
          /* 拖到最右＝停在结束那一刻（十三期张老师定）：不 resume——
             resume 在引擎里命中「curCsec≥total → 从头重播」分支，
             语义留给「播放按钮在 ended 态」专属（重播） */
          if (d.wasPlaying && csec < total) onResume();
        }}
        onPointerCancel={() => {
          const d = dragRef.current;
          if (!d.active) return;
          d.active = false;
          cancelFrame();
          /* cancel 时无松手坐标：按最后帧位置判定（d.lastCsec） */
          if (d.wasPlaying && d.lastCsec < total) onResume();
        }}
      >
        {/* thumb 挂 rail 内：left 百分比锚 rail 宽（=轨道宽−左右内衬 10px），
            两端 thumb 半宽 10px 恰好落在轨道边框内——修 100% 时超出容器 */}
        <div className="rb_rail">
          <div className="rb_fill" style={{ width: (pct * 100).toFixed(2) + "%" }} />
          <div className="rb_thumb" style={{ left: (pct * 100).toFixed(2) + "%" }} />
        </div>
      </div>
    </div>
  );
}

/* ---- 全屏回放层（十期张老师需求；十七期改版） ----
   复用在线练习的全屏口径：遮罩点击退出、自适应尺寸尽量吃满屏幕、滚轮调比例
   （上滑放大 0.1x/格、单事件封顶 5 格，练习页 onWheelZoom 同参数）。
   十七期（2026-10-16 张老师定）：界面与在线练习完全一致——银灰外框（.gwrap）+
   凹面计数条（.gbar：LED 雷数 / 笑脸 / LED 计时，CSS 自 #online_play 同名一组
   1:1 移植）；右栏「录像评级」撤除，空间留给游戏界面；点笑脸＝自己玩本局
   （同一盘面，试玩引擎练习页同款交互），试玩中再点＝重开本局。
   笑脸状态与点击相关（练习页口径）：按下 ooh / 松开 smile / 终局 win·dead。
   布局两栏：左＝数据统计、中＝游戏窗（计数条+棋盘+控制条，zoom 挂中栏）。
   ⚠️ FS 层的 Board id 用 fs_{boardId}：与页面 board_{boardId} 不撞 DOM id。 */
const VFS_MIN_ZOOM = 0.5;
const VFS_MAX_ZOOM = 3;
/* 面板缩放下限（十四期口径保留）：面板 1x 字号 13px，随棋盘等比、下限 1.05 */
const PANEL_MIN_Z = 1.05;
const VFS_ZOOM_LS = "video_replay_fs_zoom";
/* 滚轮步进（练习页 WHEEL_* 同款参数） */
const VFS_WHEEL_STEP_PX = 100;
const VFS_WHEEL_STEP_Z = 0.1;
const VFS_WHEEL_MAX_STEPS = 5;
/* 练习页游戏窗的固定布局开销（1x CSS px，fitZoom 高度预算用）：
   gwrap padding 9×2 + border 3×2 = 24；gbar（LED 25 + padding 4×2 + border 2×2 + margin 9）= 46 */
const GWRAP_OVERHEAD_Y = 70;
const GWRAP_OVERHEAD_X = 24;

/* LED 数码管渲染（练习页 led 同款：-99~999 钳制、负数两格+负号） */
function ledRender(uses: NodeListOf<SVGElement> | undefined | null, v: number) {
  if (!uses || uses.length < 3) return;
  v = Math.max(-99, Math.min(999, Math.round(v)));
  const a = Math.abs(v);
  const ds: (string | number)[] =
    v < 0 ? ["minus", ((a / 10) | 0) % 10, a % 10] : [((a / 100) | 0) % 10, ((a / 10) | 0) % 10, a % 10];
  for (let k = 0; k < 3; k++) uses[k].setAttribute("href", "#count-" + ds[k]);
}

/* 2026-10-22 导出：后台审核播放器（AdminVideoPlayer）直接复用本全屏层
 *  （standalone 模式：无页面棋盘，引擎直跑 FS 棋盘）——前台详情页/后台审核
 *  同一套播放器 UI（游戏窗/计数条/控制条/数据统计面板/滚轮缩放）。 */
export function ReplayFullscreen({
  level,
  boardId,
  boardStr,
  stats = null,
  status = "idle",
  replayData = null,
  engineFace = "smile",
  radarPoints,
  radarOverall: radarOverallProp,
  radarDists,
  noflag,
  autoEnterPlay,
  onAutoEnterDone,
  onToggle = () => {},
  onPause = () => {},
  onSeek = () => {},
  onResume = () => {},
  onExit,
  standalone = false,
  fsData = null,
  header,
}: {
  level: VideoLevel;
  boardId: number;
  boardStr: string;
  /** Provider 的回放统计（standalone 下不传，用内部 fsStats） */
  stats?: ReplayStats | null;
  /** Provider 的回放状态（standalone 下不传，用内部 fsStatus） */
  status?: Status;
  /** Provider 持有的解析产物（试玩引擎锁定同盘布雷的数据源） */
  replayData?: ReplayData | null;
  /** 回放引擎的笑脸状态（十七期：按下 ooh / 松开 smile / 终局 win·dead） */
  engineFace?: FaceKind;
  /** 全屏右栏「录像评级」数据（十九期恢复；与详情页右栏同源） */
  radarPoints?: VideoAnalysisPoint[];
  radarOverall?: string;
  /** 本录像所属组（级别 × 模式）的分位基准——试玩结束「我的评级」同基准打分（二十期） */
  radarDists?: Partial<Record<MetricKey, number[]>>;
  /** 打法（2026-10-28）：「我的评级」效率轴按组选指标（NF=IOE / FL=ThrP） */
  noflag?: boolean;
  /** 二十一期一键试玩：挂载即自动「点笑脸」进试玩（等价点全屏后点笑脸） */
  autoEnterPlay?: boolean;
  /** 自动试玩一次性 flag 的回收（触发或层卸载时调用） */
  onAutoEnterDone?: () => void;
  onToggle?: () => void;
  onPause?: () => void;
  onSeek?: (csec: number) => void;
  onResume?: () => void;
  onExit: () => void;
  /** 独立模式（2026-10-22 后台审核播放器）：无页面棋盘可镜像，回放引擎直接
   *  跑在 FS 棋盘上；试玩与右栏评级不开放（审核场景只看）。status/stats/
   *  engineFace 等 props 被内部自持状态取代，仅需传 fsData/onExit。 */
  standalone?: boolean;
  /** standalone 数据源：外部 fetch+parse 的解析产物（就绪即自动开播） */
  fsData?: ReplayData | null;
  /** standalone 顶部信息条（标题/关闭按钮，由调用方组装） */
  header?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<number | null>(null);
  const wheelAcc = useRef(0);
  /* 十八期（游戏窗 ≥ 面板高）：面板自然尺寸测量 + 面板 zoom 记账 + 落盘定时器；
     十九期加宽度（--vprfs-pw 驱动右栏评级 1.5 倍宽） */
  const panelRef = useRef<HTMLDivElement>(null);
  const panelZRef = useRef(PANEL_MIN_Z);
  const panelNatHRef = useRef(0);
  const panelNatWRef = useRef(0);
  const dropTRef = useRef<number | undefined>(undefined);
  /* 十七期：回放/试玩双模式——replay＝引擎镜像 + 事件驱动笑脸/计数条；
     play＝试玩引擎（点笑脸进入），退出回 replay（回放从定格处继续）。
     笑脸显示源：回放态＝engineFace（引擎事件驱动）、试玩态＝本地 face。
     二十一期补丁：一键试玩（autoEnterPlay）时初始即 "play"——挂载帧镜像 rAF
     不启动（否则把页面回放引擎已重演几帧的开格抄进 FS 污染干净盘面），
     FS 棋盘也从空盘渲染（boardStr 是录像终局图，见 Board 处注释） */
  const [mode, setMode] = useState<"replay" | "play">(autoEnterPlay ? "play" : "replay");
  /* ---- standalone 自持状态（2026-10-22 后台审核播放器）----
     页面态的 status/stats/engineFace 来自 Provider props；standalone 下没有
     Provider，本组件自持同构状态机（引擎 onStats/onFace/onEnd 驱动）。 */
  const [fsStatus, setFsStatus] = useState<Status>("idle");
  const [fsStats, setFsStats] = useState<ReplayStats | null>(null);
  const [fsFace, setFsFace] = useState<FaceKind>("smile");
  const fsEngineRef = useRef<Engine | null>(null);
  /* 四模式开关（二十一期 NF/速旗/连击 + 2026-10-29 左键双击），行为与
     练习页同口径；初始值**继承练习页设置**（online_play_settings 的
     nf/combo/autoChord/leftDbl 四键——张老师定的「试玩模式开关跟随练习页」）；
     写回**独立键** vprfs_play_modes（不动练习页存档——练习页那份数据
     级别更重，别让试玩的临时偏好污染它）。NF 与速旗互斥（练习页 2026-10-16 口径）。
     ⚠️ localStorage 读取放 lazy 初始化器（react-hooks/set-state-in-effect 禁止
     effect 体内同步 setState；SSR 下 localStorage 不存在须 typeof 守卫） */
  const readInitModes = (): { nf: boolean; qf: boolean; combo: boolean; ld: boolean; hf: boolean; hd: number } => {
    if (typeof document === "undefined") return { nf: false, qf: false, combo: false, ld: false, hf: false, hd: 150 };
    const read = (s: { nf?: boolean; combo?: boolean; autoChord?: boolean; leftDbl?: boolean; holdFlag?: boolean; holdDelay?: number }) => ({
      nf: typeof s.nf === "boolean" ? s.nf : false,
      qf: typeof s.autoChord === "boolean" ? s.autoChord : false,
      combo: typeof s.combo === "boolean" ? s.combo : false,
      ld: typeof s.leftDbl === "boolean" ? s.leftDbl : false,
      hf: typeof s.holdFlag === "boolean" ? s.holdFlag : false,
      hd: typeof s.holdDelay === "number" && Number.isFinite(s.holdDelay) ? Math.max(100, Math.min(400, Math.round(s.holdDelay))) : 150,
    });
    try {
      /* 优先级：试玩自己的存档 > 练习页设置（首次试玩继承）> 全关 */
      const raw = localStorage.getItem("vprfs_play_modes");
      if (raw) return read(JSON.parse(raw));
      const opRaw = localStorage.getItem("online_play_settings");
      if (opRaw) return read(JSON.parse(opRaw));
    } catch {
      /* 隐私模式/脏数据：全关 */
    }
    return { nf: false, qf: false, combo: false, ld: false, hf: false, hd: 150 };
  };
  const [initModes] = useState(readInitModes);
  const [playNf, setPlayNf] = useState(initModes.nf);
  const [playQuickFlag, setPlayQuickFlag] = useState(initModes.qf);
  const [playCombo, setPlayCombo] = useState(initModes.combo);
  const [playLeftDbl, setPlayLeftDbl] = useState(initModes.ld);
  /* 长按标雷（2026-10-29 练习页口径同步）：试玩层无独立 UI 入口，
     跟随练习页设置（继承 initModes 后全程只读镜像进 modesRef） */
  const [playHoldFlag] = useState(initModes.hf);
  const [playHoldDelay] = useState(initModes.hd);
  const savePlayModes = useCallback((nf: boolean, qf: boolean, combo: boolean, ld: boolean) => {
    try {
      localStorage.setItem("vprfs_play_modes", JSON.stringify({ nf, qf: qf, combo, ld }));
    } catch {
      /* 隐私模式 */
    }
  }, []);
  /* 开关切换（二十一期）：NF↔速旗互斥；NF 切换即重开本局（练习页口径——NF 下
     已插的旗语义不连续）；速旗/连击只改行为不重开。状态变更即写盘。
     重开通过 startPlayRef 转发（startPlay 在下方声明，引用晚绑定） */
  const startPlayRef = useRef<() => void>(() => {});
  const togglePlayNf = useCallback(() => {
    const nv = !playNf;
    const nq = nv ? false : playQuickFlag; // NF 与速旗互斥
    setPlayNf(nv);
    setPlayQuickFlag(nq);
    savePlayModes(nv, nq, playCombo, playLeftDbl);
    if (mode === "play") startPlayRef.current(); // NF 切换重开本局
  }, [playNf, playQuickFlag, playCombo, playLeftDbl, mode, savePlayModes]);
  const togglePlayQuickFlag = useCallback(() => {
    const nv = !playQuickFlag;
    const nn = nv ? false : playNf; // 互斥：开速旗关 NF
    setPlayQuickFlag(nv);
    setPlayNf(nn);
    savePlayModes(nn, nv, playCombo, playLeftDbl);
  }, [playNf, playQuickFlag, playCombo, playLeftDbl, savePlayModes]);
  const togglePlayCombo = useCallback(() => {
    const nv = !playCombo;
    setPlayCombo(nv);
    savePlayModes(playNf, playQuickFlag, nv, playLeftDbl);
  }, [playNf, playQuickFlag, playLeftDbl, savePlayModes]);
  /* 「左键双击」（2026-10-29 练习页口径同步）：左键点击已开数字视为双击；
     独立开关、不互斥不重开（速旗收窄为仅右键后从速旗移交出来） */
  const togglePlayLeftDbl = useCallback(() => {
    const nv = !playLeftDbl;
    setPlayLeftDbl(nv);
    savePlayModes(playNf, playQuickFlag, playCombo, nv);
  }, [playNf, playQuickFlag, playCombo, playLeftDbl, savePlayModes]);
  /* 引擎模式读数（getModes）：ref 镜像最新 state，事件入口现读即时生效
     （渲染期不写 ref——react-hooks/refs 口径，同步收进 effect） */
  const modesRef = useRef({ nf: false, quickFlag: false, combo: false, leftDbl: false, holdFlag: false, holdDelay: 150 });
  useEffect(() => {
    modesRef.current = { nf: playNf, quickFlag: playQuickFlag, combo: playCombo, leftDbl: playLeftDbl, holdFlag: playHoldFlag, holdDelay: playHoldDelay };
  }, [playNf, playQuickFlag, playCombo, playLeftDbl, playHoldFlag, playHoldDelay]);
  const getModes = useCallback(() => modesRef.current, []);
  /* NF 被拦反馈：抖 NF 钮（练习页 shakeModeBtn 同款视觉） */
  const nfBtnRef = useRef<HTMLButtonElement | null>(null);
  const onNfBlocked = useCallback(() => {
    const b = nfBtnRef.current;
    if (!b) return;
    b.classList.remove("pg_shake");
    void b.offsetWidth; // 强制 reflow 重放动画
    b.classList.add("pg_shake");
  }, []);
  const [face, setFace] = useState<FaceKind>("smile");
  const playRef = useRef<{ destroy: () => void } | null>(null);
  const faceUseRef = useRef<SVGUseElement | null>(null);
  /* 试玩面板数值：本地 state（Provider stats 是回放时钟，两套不混用） */
  const [playStats, setPlayStats] = useState<ReplayStats | null>(null);
  /* 试玩终局成绩（二十期）：非空＝本局已结束，右栏由「录像评级」切「我的评级」。
     进入试玩 / 重开 / 回到回放一律清空（见 startPlay / enterPlay / exitPlay） */
  const [playResult, setPlayResult] = useState<PlayResult | null>(null);
  /* 试玩数据源快照：enterPlay 事件里从 prop 取（事件回调中读 prop 是新鲜值，
     渲染期不碰 ref——react-hooks/refs 口径） */
  const replayDataRef = useRef<ReplayData | null>(null);
  useEffect(() => {
    replayDataRef.current = replayData;
  }, [replayData]);

  /* 笑脸渲染：use href 切贴图（练习页 setFace 同款；press 为瞬时态不记忆）。
     显示源按模式切换：replay＝engineFace、play＝本地 face */
  const faceShown = standalone ? fsFace : mode === "play" ? face : engineFace;
  useEffect(() => {
    faceUseRef.current?.setAttribute("href", "#" + FACE_MAP[faceShown]);
  }, [faceShown]);

  /* 挂载下一帧再显形（同 #fs_tip 的做法：插入帧先 opacity:0，避免层闪现） */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 卸载兜底（层卸载＝退出全屏：试玩引擎若在跑一并销毁，纯副作用无 setState） */
  useEffect(
    () => () => {
      playRef.current?.destroy();
      playRef.current = null;
      fsEngineRef.current?.stop();
      fsEngineRef.current = null;
    },
    []
  );

  /* ---- standalone 引擎接线（2026-10-22 后台审核播放器）----
     fsData prop 就绪（外部 fetch+parse 完成）即自动开播：引擎直挂 FS 棋盘
     （.vprfs_board_wrap + .gframe tbody），onStats/onFace/onEnd 驱动本组件
     自持状态（fsStats/fsFace/fsStatus → 计数条 LED/控制条/笑脸）。
     rAF 下一帧启动：portal DOM 需先挂载（Board 渲染出 tbody 才能 runReplay）。
     重播（ended 后点播放/笑脸）走 fsEngineRef.restart()。 */
  const startFsEngine = useCallback(
    (d: ReplayData) => {
      const wrap = wrapRef.current?.querySelector<HTMLElement>(".vprfs_board_wrap");
      const tbody = wrapRef.current?.querySelector<HTMLTableSectionElement>(".gframe tbody");
      if (!wrap || !tbody) return;
      const rows = tbody.rows.length;
      const cols = rows ? tbody.rows[0].cells.length : 0;
      if (!rows || !cols) return;
      if (d.w !== cols || d.h !== rows) return;
      fsEngineRef.current?.stop();
      fsEngineRef.current = runReplay({
        wrap,
        tbody,
        rows,
        cols,
        data: d,
        onEnd: () => setFsStatus("ended"),
        onStats: setFsStats,
        onFace: setFsFace,
        getHostZoom: () => zoomRef.current ?? 1,
      });
      setFsStatus("playing");
    },
    []
  );
  useEffect(() => {
    if (!standalone || !fsData) return;
    const raf = requestAnimationFrame(() => {
      if (!fsEngineRef.current) startFsEngine(fsData);
    });
    return () => cancelAnimationFrame(raf);
  }, [standalone, fsData, startFsEngine]);

  /* 试玩启动（进入 + 重开共用）：盘面残留由试玩引擎自身重置（state 全 0 起步）。
     playStats 的清理由本函数在启动前统一做（替代模式 effect 里的 setState——
     react-hooks/set-state-in-effect 禁止在 effect 体里同步置 state）。
     光标在试玩态即刻隐藏（镜像 rAF 已停，残留会钉在原地） */
  const startPlay = useCallback(() => {
    const host = wrapRef.current?.querySelector<HTMLElement>(".vprfs_board_wrap");
    const tbody = wrapRef.current?.querySelector<HTMLTableSectionElement>(".gframe tbody");
    const data = replayDataRef.current;
    if (!host || !tbody || !data) return;
    const rows = tbody.rows.length;
    const cols = rows ? tbody.rows[0].cells.length : 0;
    if (!rows || !cols) return;
    const cursor = host.querySelector<HTMLElement>(".replay_cursor");
    if (cursor) cursor.style.display = "none";
    playRef.current = runPlayGame({
      boardHost: host,
      tbody,
      rows,
      cols,
      data,
      onFace: (k) => setFace(k === "press" ? "smile" : k),
      onStats: setPlayStats,
      onFinish: setPlayResult,
      getModes,
      onNfBlocked,
      level,
    });
    setFace("smile");
  }, [getModes, onNfBlocked, level]);
  /* 晚绑定 startPlay（togglePlayNf 的 NF 切换重开入口；渲染期不写 ref） */
  useEffect(() => {
    startPlayRef.current = startPlay;
  }, [startPlay]);

  /* 点笑脸：回放态＝暂停回放进入试玩；试玩态＝重开本局（练习页 F2 口径） */
  const enterPlay = useCallback(() => {
    playRef.current?.destroy(); // 重开路径同款：旧引擎监听/定时器全清
    playRef.current = null;
    setPlayStats(null); // 旧试玩面板数值即刻作废
    setPlayResult(null); // 上一局的「我的评级」随即撤下（重开＝新的一局）
    if (mode !== "play") {
      onPause(); // 回放定格（exitPlay 回来时从定格处继续）
      setMode("play");
    }
    startPlay();
  }, [mode, onPause, startPlay]);

  /* 一键试玩直达（二十一期）：autoEnterPlay 置位时挂载即自动 enterPlay
     （等价「点全屏按钮 + 点笑脸」两步）。enterPlay 需要棋盘 DOM 已挂载，
     故放 rAF 下一帧执行；fire-and-forget（不挂 cleanup 取消——onAutoEnterDone
     的 setState 会立刻改 deps 触发 cleanup 把 rAF 误杀；层若在下一帧前卸载，
     startPlay 的空守卫自然吞掉）。doneRef 防重入：deps 波动不二次进试玩。
     ⚠️ mode 已在 useState 初始化为 "play"（本层挂载帧镜像 rAF 就不启动），
     但页面回放引擎还在跑（playGame 起播后它 playing 中）——先 onPause() 定格，
     否则 exitPlay 回 replay 时引擎从已跑远的时间点继续（试玩刚开时它还
     在页面侧继续重演进度）。 */
  const autoPlayDoneRef = useRef(false);
  useEffect(() => {
    if (!autoEnterPlay || autoPlayDoneRef.current) return;
    autoPlayDoneRef.current = true;
    onAutoEnterDone?.();
    onPause(); // 页面回放引擎定格（mode 已是 play，镜像 rAF 不在跑）
    requestAnimationFrame(() => enterPlay());
  }, [autoEnterPlay, enterPlay, onAutoEnterDone, onPause]);

  /* 退出试玩回到回放：销毁试玩引擎 + 面板切回回放统计（事件回调里 setState 合法）；
     镜像 rAF 自动把页面引擎的盘面抄回 FS 棋盘 */
  const exitPlay = useCallback(() => {
    playRef.current?.destroy();
    playRef.current = null;
    setPlayStats(null);
    setPlayResult(null);
    setMode("replay");
  }, []);

  /* 试玩结束的「我的评级」（二十期 2026-10-16 张老师定）：级别 + 本录像所属的分位基准
     （radarDists prop）在客户端算出与「录像评级」同一套五轴点 —— 组装与评级全部走
     lib/videoscore 的共享件，本文件不自造口径。
     STNB / 3BV/s / IOE / Corr / Cls 五个原始值的算法与练习页结算面板、左侧数据面板
     同式（ReplayStatsTable 里那一段）；可评级的门槛（零点击 / 完成度 < 10%）同练习页。 */
  const mineRating = useMemo(() => {
    if (!playResult) return null;
    const t = playResult.csec / 100;
    const hasBv = playResult.solvedBv > 0 && t > 0;
    const ln = level === "beg" ? 1 : level === "int" ? 2 : 3;
    const qg = hasBv ? Math.pow(t, 1.7) / playResult.solvedBv : 0;
    const stnb = hasBv
      ? ((73.5 * ln * ln - 94.5 * ln + 57) / qg) * Math.sqrt(playResult.solvedBv / playResult.board3bv)
      : 0;
    const values: Partial<Record<MetricKey, number>> = {
      stnb,
      bvs: hasBv ? playResult.solvedBv / t : 0,
      ioe: playResult.cl > 0 ? playResult.solvedBv / playResult.cl : 0,
      thrp: playResult.ce > 0 ? playResult.solvedBv / playResult.ce : 0,
      corr: playResult.cl > 0 ? playResult.ce / playResult.cl : 0,
      cls: t > 0 ? playResult.cl / t : 0,
      bpp: playResult.path > 0 ? playResult.solvedBv / (playResult.path / 16) : 0,
    };
    const lowCompletion = playResult.board3bv <= 0 || playResult.solvedBv / playResult.board3bv < 0.1;
    const points = radarPointsFrom(values, radarDists, !!radarDists && playResult.cl > 0 && !lowCompletion, noflag);
    /* 预计完成用时（未完成时展示）：Est RTime 口径 = 实际用时 × 3BV ÷ 已完成 3BV */
    const estSec = playResult.solvedBv > 0 ? t * (playResult.board3bv / playResult.solvedBv) : 0;
    return { points, overall: overallGrade(points), estSec };
  }, [playResult, level, radarDists, noflag]);

  /* 自适应基准（十九期：三栏复原——面板 + 游戏窗 + 评级栏）。
     十九期张老师定：全屏右侧恢复「录像评级」，宽度＝数据统计面板的 1.5 倍。
     难点＝面板/评级的 zoom 与棋盘 zoom 不再恒等（十八期高度对齐把 pz 封顶到
     「面板高＝游戏窗高」→ pz = z/R，R＝面板自然高/游戏窗含框基准高），
     宽度方程随 pz 分段；解在 z = zFloor 处连续，取「高度换算解」与「宽度解」较小。
     R 未实测（首帧 ref=0）时按 1 走保守估算，测量 effect 落地后立即重算。 */
  const fitZoom = useCallback((): number => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 16 * 2; // 内衬
    const showPanel = vw >= 900; // 极窄藏左面板（CSS 断点同步）
    const showSide = !standalone && vw >= 1180; // 更窄藏右评级（CSS 断点同步；standalone 无右栏）
    const gapTotal = 18 * ((showPanel ? 1 : 0) + (showSide ? 1 : 0)); // 栏间 gap 18/个
    const dim = { beg: [8, 8], int: [16, 16], exp: [30, 16] }[level] ?? [30, 16];
    const bw = dim[0] * 16 + 4 + GWRAP_OVERHEAD_X;
    const bh = dim[1] * 16 + 4 + GWRAP_OVERHEAD_Y;
    const availW0 = vw - pad - gapTotal;
    const availH = vh - pad - 24 - 42 - 10; // 顶部呼吸 24 + 控制条 42 + 间隙 10
    if (availW0 < 50 || availH < 50) return 1;
    const clamp = (v: number) => Math.max(VFS_MIN_ZOOM, Math.min(VFS_MAX_ZOOM, v));
    /* 面板宽用实测自然宽（回退 248）；右栏（录像评级 / 我的评级）渲染宽＝面板的
       1.5 倍——CSS 域宽度 1.5×pw、zoom 与面板同域（--vfz-panel），故渲染即 1.5 倍 */
    const pw = panelNatWRef.current > 0 ? panelNatWRef.current : 248;
    const sideW = pw * 1.5; // 右栏在 CSS 域占的宽（与 .vprfs_side 的 width 同式）
    const span = showPanel ? pw + (showSide ? sideW : 0) : showSide ? sideW : 0;
    const natH = panelNatHRef.current;
    const R = natH > 0 ? natH / bh : 1; // 面板 zoom = 棋盘 zoom / R（高度对齐反解）
    const zFloor = natH > 0 ? (natH * PANEL_MIN_Z) / bh : PANEL_MIN_Z; // 等高所需最小棋盘 zoom
    const zByH = availH / bh;
    /* 段判定：z = zFloor 时面板/评级已按最小倍率(1.05)铺开的宽度是否放得下 */
    const wAtFloor = bw * zFloor + span * PANEL_MIN_Z;
    const zByW =
      wAtFloor <= availW0
        ? availW0 / (bw + span / R) // 段 1：z ≥ zFloor，面板/评级随 z/R 等比
        : (availW0 - span * PANEL_MIN_Z) / bw; // 段 2：宽度吃紧，面板/评级钉在最小倍率
    return clamp(Math.min(zByW, zByH));
  }, [level, standalone]);

  /* 统一 zoom 施加（十八期重构）：地板/上限/面板 zoom 收敛到一处。
     十八期张老师定「全屏时游戏版图至少要和数据统计栏高度相同」——
     棋盘 zoom 地板＝面板最小倍率(1.05)高度折算值（面板自然高由测量 effect 回填）；
     面板 zoom 改「面板高 ≤ 游戏窗高」封顶（十一期的恒等比绑定在面板内容天然
     比棋盘高时永不收敛，作废）；
     上限＝视口 fit（十二期口径），地板超上限时让位视口（小屏放不下则随它去）。 */
  const applyZoom = useCallback(
    (next: number, persist = true) => {
      const el = wrapRef.current;
      if (!el) return;
      const dim = { beg: [8, 8], int: [16, 16], exp: [30, 16] }[level] ?? [30, 16];
      const bh = dim[1] * 16 + 4 + GWRAP_OVERHEAD_Y;
      const natH = panelNatHRef.current;
      const cap = Math.min(VFS_MAX_ZOOM, fitZoom());
      const floor = natH > 0 ? Math.min((natH * PANEL_MIN_Z) / bh, cap) : VFS_MIN_ZOOM;
      const z = Math.min(cap, Math.max(floor, next));
      /* 面板 zoom：min(棋盘 zoom 与下限 1.05 取大, 面板高=游戏窗高的封顶)——
         natH<bh（棋盘本比面板高）时封顶>z，自然退回等比行为 */
      const pz =
        natH > 0
          ? Math.min(Math.max(PANEL_MIN_Z, z), Math.max(PANEL_MIN_Z, (bh * z) / natH))
          : Math.max(PANEL_MIN_Z, z);
      zoomRef.current = z;
      panelZRef.current = pz;
      el.style.setProperty("--vfz", String(z));
      el.style.setProperty("--vfz-panel", String(pz));
      if (persist) {
        window.clearTimeout(dropTRef.current);
        dropTRef.current = window.setTimeout(() => localStorage.setItem(VFS_ZOOM_LS, String(z)), 320);
      }
    },
    [fitZoom, level]
  );

  /* 初始倍率：记住的滚轮值（过地板/上限收敛）→ 没有则视口 fit */
  useEffect(() => {
    if (zoomRef.current === null) {
      let z = parseFloat(localStorage.getItem(VFS_ZOOM_LS) || "");
      if (!Number.isFinite(z)) z = fitZoom();
      applyZoom(z, false);
    }
  }, [fitZoom, applyZoom]);

  /* 面板自然尺寸测量（十八期高 / 十九期宽）：每次渲染后测一次（行数恒定，
     几何稳定后只读不写；CSS zoom 的 rect 是放大后的，除回当前面板 zoom 得自然值）。
     高变化 → 重施 zoom（纯 DOM 写，无 setState）：首测把地板从 0.5 抬到面板折算值，
     游戏窗随之上抬到与面板等高；
     宽变化 → 写 --vprfs-pw（右栏评级 = 1.5×面板宽的 CSS 来源）；不重算 zoom，
     避免数字位数微变引起整体缩放抖动。 */
  useEffect(() => {
    const el = panelRef.current;
    if (!el || el.offsetParent === null) return; // 窄屏 display:none 跳过
    const pz = panelZRef.current || PANEL_MIN_Z;
    const rect = el.getBoundingClientRect();
    const h = rect.height / pz;
    const w = rect.width / pz;
    if (w > 0 && Math.abs(w - panelNatWRef.current) > 1) {
      panelNatWRef.current = w;
      wrapRef.current?.style.setProperty("--vprfs-pw", `${w.toFixed(1)}px`);
    }
    if (h > 0 && Math.abs(h - panelNatHRef.current) > 2) {
      panelNatHRef.current = h;
      applyZoom(zoomRef.current ?? 1, false);
    }
  });

  /* 滚轮调比例（练习页口径：上滑放大、累计 100px 迈 0.1x、单事件封顶 5 格、停滚落盘；
     十八期：缩不出「游戏窗矮于面板」——applyZoom 内含地板） */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += e.deltaY;
      const steps = Math.min(VFS_WHEEL_MAX_STEPS, Math.abs(wheelAcc.current) / VFS_WHEEL_STEP_PX);
      if (steps < 1) return;
      wheelAcc.current = 0;
      const dir = e.deltaY < 0 ? 1 : -1;
      const cur = zoomRef.current ?? 1;
      applyZoom(cur + dir * VFS_WHEEL_STEP_Z * Math.floor(steps));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      window.clearTimeout(dropTRef.current);
    };
  }, [applyZoom]);

  /* 窗口缩放：按新视口 refit（zoom 统一走 applyZoom，地板/上限随视口重算） */
  useEffect(() => {
    const onResize = () => applyZoom(zoomRef.current ?? 1, false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyZoom]);

  /* 镜像（十七期加 mode 门控）：回放态 rAF 逐帧把页面回放引擎的格子类名抄到
     FS 棋盘 + 光标位置换算；试玩态跳过（试玩引擎直接画 FS 棋盘）。
     ⚠️ Board 组件内部把 id 渲染成 `board_{id}`（FS 传 "fs_board_338799" → 实际
     id="board_fs_board_338799"）——十期选择器写 #fs_board_* 从未匹配，棋盘一直
     显示的是 boardStr 静态终局图（碰巧「看起来对」），回放中盘根本不同步。
     ⚠️ 光标坐标系（十一期修）：两侧棋盘不在同一视口位置，视口差换算是错的；
     正确参照系＝棋盘表本体——页面光标相对页面棋盘的比例 × FS 棋盘当前尺寸，
     缩放级别（滚轮）变化后每帧重算自动同步。 */
  useEffect(() => {
    if (mode !== "replay" || standalone) return;
    let raf = 0;
    const mirror = () => {
      const srcTable = document.querySelector<HTMLTableSectionElement>(`#board_${boardId} tbody`);
      const dstTable = document.querySelector<HTMLTableSectionElement>(`#board_fs_board_${boardId} tbody`);
      if (srcTable && dstTable) {
        const srcRows = srcTable.rows;
        const dstRows = dstTable.rows;
        for (let r = 0; r < srcRows.length; r++) {
          const sc = srcRows[r].cells;
          const dc = dstRows[r].cells;
          for (let c = 0; c < sc.length; c++) {
            /* 踩雷格是 bmb 类 + 内嵌红雷 SVG（paintBombCell）：类名变到 bmb 时
               连 innerHTML 一起抄；反向（红雷→普通格）清掉残留 SVG。
               正常格 innerHTML 恒空，不逐帧序列化比对（60fps 性能） */
            const scls = sc[c].className;
            if (dc[c].className !== scls) {
              dc[c].className = scls;
              if (scls === "bmb") dc[c].innerHTML = sc[c].innerHTML;
              else if (dc[c].innerHTML) dc[c].innerHTML = "";
            }
          }
        }
      }
      const srcCur = document.querySelector<HTMLElement>("#video_view .replay_cursor");
      const dstCur = wrapRef.current?.querySelector<HTMLElement>(".replay_cursor");
      const srcBoard = document.querySelector<HTMLElement>(`#board_${boardId}`);
      const dstBoard = document.querySelector<HTMLElement>(`#board_fs_board_${boardId}`);
      if (srcCur && dstCur && srcBoard && dstBoard) {
        const cr = srcCur.getBoundingClientRect();
        const sr = srcBoard.getBoundingClientRect();
        if (sr.width > 1 && cr.width > 0) {
          /* 页面光标尖端相对页面棋盘**表格**的比例 → FS 表格上的落点。
             ⚠️ 比例域用 table 而非 board div：事件坐标（16px/格）落在表格内，
             表格相对 div 有 2px 边框偏移（页面引擎 off 同口径）；两侧同取 table
             则偏移自消。FS 光标在 zoom 容器内：CSS left/top 会被 zoom 放大，
             换算回 CSS 域除以 zoom（每帧实时取，滚轮缩放后自动同步）；
             尖端锚 (0.5,1.21) 与页面引擎 TIP 口径一致。 */
          const z = zoomRef.current ?? 1;
          const srcTable = srcBoard.querySelector("table");
          const dstTableEl = dstBoard.querySelector("table");
          if (!srcTable || !dstTableEl) return;
          const st = srcTable.getBoundingClientRect();
          const dt = dstTableEl.getBoundingClientRect();
          const tipX = cr.left + 0.5 * (cr.width / 12); // 尖端（宽=12×页面侧缩放）
          const tipY = cr.top + 1.21 * (cr.height / 19);
          const rx = (tipX - st.left) / st.width;
          const ry = (tipY - st.top) / st.height;
          /* 光标容器挂在 .vprfs_board_wrap（紧贴 board div 外框）：比例域是 table，
             须补 table 相对 wrap 的渲染偏移（board div 2px 边框 × zoom）除回 CSS 域 */
          const fsWrap = dstCur.parentElement?.getBoundingClientRect();
          const offX = fsWrap ? (dt.left - fsWrap.left) / z : 0;
          const offY = fsWrap ? (dt.top - fsWrap.top) / z : 0;
          dstCur.style.left = offX + (rx * dt.width) / z - 0.5 + "px";
          dstCur.style.top = offY + (ry * dt.height) / z - 1.21 + "px";
        }
        dstCur.style.display = cr.width > 0 ? "block" : "none";
      }
      raf = requestAnimationFrame(mirror);
    };
    raf = requestAnimationFrame(mirror);
    return () => cancelAnimationFrame(raf);
  }, [boardId, mode, standalone]);

  /* 回放态计数条：LED 雷数＝totalMines − flags（胜利时归 0——练习页 L2495 口径：
     flags 改为只计玩家实际插旗后，终值不再「恰好」等于雷数，须显式 win 置 0）、
     LED 时间＝回放时钟整数秒（笑脸由 Provider 的 engineFace prop 驱动，见下；
     standalone 无 Provider——数据源切自持 fsStats/fsFace） */
  const ledStats = standalone ? fsStats : stats;
  const ledFace = standalone ? fsFace : engineFace;
  useEffect(() => {
    if (mode !== "replay") return;
    const uses = wrapRef.current?.querySelectorAll<SVGElement>("#fs_led_mines use.d");
    if (ledStats) ledRender(uses, ledFace === "win" ? 0 : ledStats.totalMines - ledStats.flags);
  }, [mode, ledStats, ledFace]);
  useEffect(() => {
    if (mode !== "replay") return;
    const uses = wrapRef.current?.querySelectorAll<SVGElement>("#fs_led_time use.d");
    if (ledStats) ledRender(uses, Math.floor(ledStats.csec / 100));
  }, [mode, ledStats]);

  /* 回放态棋盘点击不再退出（练习页语义：棋盘是对局区）；退出全屏走
     遮罩空白/Esc/控制条按钮——沿用十期遮罩命中口径 */

  if (typeof document === "undefined") return null;
  const showStats = standalone ? fsStats : mode === "play" ? playStats : stats;
  /* standalone 控制条回调（引擎直挂 FS 棋盘，无 Provider）：ended 后重播走
     restart；seek/pause/resume 直通引擎 */
  const fsToggle = () => {
    if (fsStatus === "playing") {
      fsEngineRef.current?.pause();
      setFsStatus("paused");
    } else {
      /* paused/ended 同门：引擎 resume 在终点时自动从头重播（练习页六期口径） */
      fsEngineRef.current?.resume();
      setFsStatus("playing");
    }
  };
  const fsPause = () => {
    if (fsStatus === "playing") {
      fsEngineRef.current?.pause();
      setFsStatus("paused");
    }
  };
  const fsResume = () => {
    if (fsStatus === "paused") {
      fsEngineRef.current?.resume();
      setFsStatus("playing");
    }
  };
  const fsSeek = (csec: number) => {
    if (!fsEngineRef.current || !fsStats) return;
    fsEngineRef.current.seek(csec);
    setFsStatus(csec >= fsStats.totalCsec ? "ended" : "paused");
  };
  return createPortal(
    <div
      className={"vprfs" + (mounted ? " show" : "")}
      ref={wrapRef}
      onClick={(e) => {
        /* 退出判定＝「点击落在两栏内容实体之外」：遮罩/层本体，或 .vprfs_inner 的
           空白区（十七期实测：左栏面板比游戏窗高时，游戏区正下方的 inner 空白
           挂着 stopPropagation 吞点击，底部大块「看着是遮罩」的点不退出）。 */
        if (
          e.target === e.currentTarget ||
          (e.target as HTMLElement).classList?.contains("vprfs_mask") ||
          (e.target as HTMLElement).classList?.contains("vprfs_inner")
        )
          onExit();
      }}
    >
      {/* 视觉遮罩（命中判定在 .vprfs 的 onClick 统一处理） */}
      <div className="vprfs_mask" />
      {/* standalone 顶部信息条（2026-10-22 后台审核）：调用方组装（标题+关闭），
          绝对定位右上角（standalone 无右栏，该区域空白） */}
      {standalone && header && (
        <div className="vprfs_header" onClick={(e) => e.stopPropagation()}>
          {header}
        </div>
      )}
      {/* inner 空白区（面板/游戏窗之外的容器本体）＝退出热区：e.target===自身时退出；
          点击落在子内容上则照旧 stopPropagation 保护（冒泡到 inner 时 target 是子元素） */}
      <div
        className="vprfs_inner"
        onClick={(e) => {
          if (e.target === e.currentTarget) onExit();
          else e.stopPropagation();
        }}
      >
        {/* 左：数据统计（与页面态同一份内容组件；自然尺寸，不吃滚轮 zoom）。
            试玩态显示本局实时数据（onStats 流）；ref 供面板自然高测量（十八期） */}
        <div className="vprfs_panel replay_panel" ref={panelRef}>
          {showStats && <ReplayStatsTable level={level} s={showStats} />}
        </div>
        {/* 中：练习页同款游戏窗（.gwrap 银框：计数条+棋盘）+ 控制条（zoom 挂中栏） */}
        <div className="vprfs_center">
          <div className="gwrap">
            <div className="gbar">
              <svg className="ledc" id="fs_led_mines" viewBox="0 0 410 250" role="img" aria-label="剩余雷数">
                <use href="#top-counters" />
                <use className="d" href="#count-0" x="20" y="20" />
                <use className="d" href="#count-0" x="150" y="20" />
                <use className="d" href="#count-0" x="280" y="20" />
              </svg>
              <button
                className="face"
                id="fs_face_btn"
                type="button"
                title={standalone ? "重新播放" : mode === "play" ? "重开本局" : "自己玩本局"}
                onMouseDown={() => faceUseRef.current?.setAttribute("href", "#" + FACE_MAP.press)}
                onMouseUp={() => faceUseRef.current?.setAttribute("href", "#" + FACE_MAP[faceShown])}
                onMouseLeave={() => faceUseRef.current?.setAttribute("href", "#" + FACE_MAP[faceShown])}
                onClick={(e) => {
                  e.stopPropagation();
                  if (standalone) {
                    /* 审核场景：点笑脸＝从头重播（引擎 restart 含复位+重播） */
                    fsEngineRef.current?.restart();
                    setFsStatus("playing");
                    return;
                  }
                  enterPlay();
                }}
              >
                <svg viewBox="0 0 260 260" width="26" height="26">
                  <use ref={faceUseRef} href="#face-normal" />
                </svg>
              </button>
              <svg className="ledc" id="fs_led_time" viewBox="0 0 410 250" role="img" aria-label="计时">
                <use href="#top-counters" />
                <use className="d" href="#count-0" x="20" y="20" />
                <use className="d" href="#count-0" x="150" y="20" />
                <use className="d" href="#count-0" x="280" y="20" />
              </svg>
            </div>
            <div className="gframe">
              <div
                className="vprfs_board_wrap"
                onDragStart={(e) => e.preventDefault()} /* 游戏容器禁拖放（2026-10-24）：防原生拖拽 🚫 光标；standalone（后台审核）同层受益 */
              >
                {/* 试玩态渲染空盘（二十一期）：boardStr 是录像**终局图**（胜局全开格
                    +雷全标旗），一键试玩若按终局图渲染再靠引擎 reset 刷回，慢机器上
                    有可感知的「已开格→全闭合」闪变；runPlayGame 的初始全盘重置仍在
                    （兜底任何残留），但首帧就该是干净的未开盘面。回放态不受影响
                    （镜像 rAF 每帧把页面引擎盘面抄过来，boardStr 只是骨架）。
                    standalone（2026-10-22）：无镜像，引擎直接在本 tbody 上重演，
                    首帧同样要干净空盘。 */}
                <Board
                  id={"fs_board_" + boardId}
                  level={level}
                  board={mode === "play" || standalone ? "b".repeat(boardStr.length) : boardStr}
                  size={16}
                />
                {/* 静态光标占位（镜像 rAF 驱动其位置；standalone 不渲染——
                    引擎自建光标直挂本 wrap，静态占位会双影） */}
                {!standalone && (
                  <div className="replay_cursor" aria-hidden="true">
                    <svg viewBox="0 0 120 190" width="12" height="19" aria-hidden="true"><use href="#cursor-arrow" /></svg>
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* 控制条（回放态）：暂停/播放 + 时间 + 进度 + 退出全屏；
              试玩态：回到回放 + 提示 + 退出全屏；
              standalone：数据源/回调切自持（fsStats/fsStatus/fsToggle…） */}
          {standalone && fsStats && (
            <ReplayBar
              status={fsStatus}
              stats={fsStats}
              onToggle={fsToggle}
              onPause={fsPause}
              onSeek={fsSeek}
              onResume={fsResume}
              onFullscreen={onExit}
              fsActive
            />
          )}
          {mode === "replay" && stats && (
            <ReplayBar
              status={status}
              stats={stats}
              onToggle={onToggle}
              onPause={onPause}
              onSeek={onSeek}
              onResume={onResume}
              onFullscreen={onExit}
              fsActive
            />
          )}
          {mode === "play" && (
            <div className="replay_bar vprfs_playbar" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="rb_btn vprfs_backbtn"
                title="回到回放"
                onClick={(e) => {
                  e.stopPropagation();
                  exitPlay();
                }}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                </svg>
              </button>
              {/* 四模式开关（二十一期 NF/速旗/连击 + 2026-10-29 左键双击），
                  行为与练习页同口径（互斥、重开、连点 chord 等）；初始继承练习页
                  设置（online_play_settings），此后试玩自己的偏好独立落盘
                  （vprfs_play_modes）。图标与练习页快捷钮同款（NF 文本钮 /
                  小旗 / 左键小旗 / 连击手势） */}
              <div className="vprfs_modes">
                <button
                  ref={nfBtnRef}
                  type="button"
                  className={"rb_btn rb_mode" + (playNf ? " active" : "")}
                  title="NF 模式：不能插旗，右键已禁用（切换重开本局）"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayNf();
                  }}
                >
                  NF
                </button>
                <button
                  type="button"
                  className={"rb_btn rb_mode" + (playQuickFlag ? " active" : "")}
                  title="速旗模式：右键标雷自动双击周围数字格，右键点数字格也视为双击（与 NF 互斥）"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayQuickFlag();
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 21V3.5" />
                    <path d="M6 4.5h11.5l-3 4 3 4H6z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={"rb_btn rb_mode" + (playLeftDbl ? " active" : "")}
                  title="左键双击：左键点击已打开的数字，视为双击操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayLeftDbl();
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 4.5v7.6" />
                    <path d="M11 4.5h7l-2.4 2.8L18 10.1h-7z" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={"rb_btn rb_mode" + (playCombo ? " active" : "")}
                  title="连击模式：按下即触发，按住左/右键滑动连续点击滑过的格子"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayCombo();
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5.25 8.2a6.4 6.4 0 0 1 12.8 0" />
                    <path d="M7.75 8.2a3.9 3.9 0 0 1 7.8 0" />
                    <path d="M9.9 14.2V7.3a1.75 1.75 0 0 1 3.5 0V10.5a1.55 1.55 0 0 1 3.1 .55a1.55 1.55 0 0 1 3.1 .55V16.6a6.3 6.3 0 0 1 -9.7 3.1V14.2Z" />
                  </svg>
                </button>
              </div>
              <span className="rb_hint">试玩本局 · 点笑脸重开 · 不计成绩不上传</span>
              <button
                type="button"
                className="rb_btn active"
                title="退出全屏"
                aria-label="退出全屏"
                onClick={(e) => {
                  e.stopPropagation();
                  onExit();
                }}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 8V5h3" />
                  <path d="M19 8V5h-3" />
                  <path d="M5 16v3h3" />
                  <path d="M19 16v3h-3" />
                </svg>
              </button>
            </div>
          )}
        </div>
        {/* 右：评级卡（二十期张老师定）——
             ① 试玩**已结束**（playResult 非空）→「我的评级」：本局成绩 + 五轴评级 + 雷达
                ＋ 查看回放 / 下载录像（版式参考在线练习结算面板）；
             ② 回放态 / 试玩进行中 →「录像评级」（十九期恢复；雷达与详情页右栏同源）。
             宽度＝数据统计面板渲染宽的 1.5 倍（.vprfs_side 的 width，与面板同缩放域）；
             窄屏（<1180）CSS 隐藏；
             standalone（后台审核）不渲染——审核场景不需要评级卡 */}
        {!standalone && mode === "play" && playResult && mineRating ? (
          <div className="vprfs_side vprfs_mine">
            <h2 className="vr_h">
              我的评级
              <span className="vr_rate" style={{ color: gradeColor(mineRating.overall) }}>
                {mineRating.overall === "?" ? "—" : mineRating.overall}
              </span>
            </h2>
            <div className="vr_line" />
            {/* 成绩行：胜局＝级别名 + 级别色用时；未完成＝灰「未完成」+ 括号预计用时
                （两条口径都与练习页结算面板同一份文案规则） */}
            <div className="vr_score">
              {playResult.won ? (
                <>
                  <span>{LEVEL_NAMES[level] ?? level}</span>
                  <em className={"lv_" + level}>{(playResult.csec / 100).toFixed(2)}</em>
                  <span>秒</span>
                </>
              ) : (
                <>
                  <span className="fail">未完成</span>
                  {mineRating.estSec > 0 && (
                    <span className="est">(预计 {mineRating.estSec.toFixed(2)}秒)</span>
                  )}
                </>
              )}
            </div>
            <div className="vr_wrap">
              <VideoAnalysisRadar data={mineRating.points} fill />
            </div>
            <div className="gr_btns">
              <button
                type="button"
                className="grb"
                title="退出试玩，从头播放本录像的回放"
                onClick={(e) => {
                  e.stopPropagation();
                  exitPlay();
                  onSeek(0); // 回放回到起点（练习页「查看回放」＝从头看）
                  onResume();
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M8 5v14l11-7z" />
                </svg>
                查看回放
              </button>
              <a className="grb" href={`/video/download/${boardId}`} title="下载本录像文件">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m7 10 5 5 5-5" />
                  <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 15V3" />
                </svg>
                下载录像
              </a>
            </div>
          </div>
        ) : !standalone && radarPoints ? (
          <div className="vprfs_side">
            <h2 className="vr_h">
              录像评级
              <span className="vr_rate" style={{ color: gradeColor(radarOverallProp ?? "?") }}>
                {radarOverallProp ?? "—"}
              </span>
            </h2>
            <div className="vr_line" />
            <div className="vr_wrap">
              <VideoAnalysisRadar data={radarPoints} />
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
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
  /* 十期（2026-10-16 张老师需求）：高级盘充分使用左栏版图宽度、中级复用同比例；
     初级默认 1.5 倍（同日十三期张老师改定，原 beg 2.4 对齐高度口径作废）。
     比例口径与依据见 globals.css .zoom_* 注释 */
  const zoomCls = level === "exp" ? "zoom_exp" : level === "int" ? "zoom_int" : "zoom_beg";
  return (
    <div className="playable">
      {/* 结构沿用原 BoardPlay：.play_board 浮动收缩盒＝棋盘本体，回放光标挂这里。
          引擎定位走 board_{id}（Provider 传 boardId），此处无需 ref */}
      {/* 九期：回放中在棋盘左侧弹数据面板（十期 portal 挂 body，摆脱盒裁剪）；
          全屏层打开时页面态面板收起（全屏层自带面板） */}
      {replaying && !ctx.fullscreen && ctx.stats && <ReplayStatsPanel level={level} s={ctx.stats} />}
      <div
        className={`play_board ${zoomCls}`}
        title={replaying ? "点击退出回放" : "点击播放在线录像"}
        onDragStart={(e) => e.preventDefault()} /* 游戏容器禁拖放（2026-10-24）：防原生拖拽 🚫 光标 */
        onClick={() => {
          if (ctx.status === "idle") ctx.play();
          else if (ctx.status !== "loading") ctx.stop();
        }}
      >
        {/* 地图银框（2026-10-21 张老师需求：像练习页那样加边框，但不要计时器
            和笑脸）——复刻 #online_play .gwrap 的凸起银框形态，计数条不加；
            框在版图 zoom 域内随盘同缩（练习页 zoom 挂 gwrap 同款）。回放引擎
            光标定位按运行时量取 table 相对 wrap 偏移，加框自动适应 */}
        <div className="pb_frame">
          <Board id={id} level={level} board={board} size={16} />
        </div>
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
            {/* 三角路径包围盒精确居中（2026-10-16 十三期：bbox x∈[5.85,18.15]、
                y∈[4.11,19.89]，中心 (12,12)＝viewBox 中心）——旧路径 bbox 偏右 2.15
                再叠 CSS margin 补偿，初级高倍 zoom 下明显偏右（张老师报） */}
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
              <path d="M5.85 5.14v13.72c0 .96 1.05 1.54 1.86 1.03l10.44-6.86a1.22 1.22 0 0 0 0-2.06L7.71 4.11C6.9 3.6 5.85 4.18 5.85 5.14z" />
            </svg>
          </button>
        )}
        {/* 九期：回放控制条（棋盘正下方同宽；点击不冒泡到棋盘退出）；
            十期：加全屏按钮（进全屏回放层） */}
        {replaying && ctx.stats && (
          <ReplayBar
            status={ctx.status}
            stats={ctx.stats}
            onToggle={ctx.togglePlay}
            onPause={ctx.pause}
            onSeek={ctx.seek}
            onResume={ctx.resume}
            onFullscreen={() => ctx.setFullscreen(true)}
          />
        )}
      </div>
    </div>
  );
}

/** 「播放」「试玩」按钮（替代原 PlayButton）：
 *  播放——加载中禁用；回放中/结束＝「重播」；hover 时按钮下方弹深灰气泡
 *  「使用Flop Player播放」（2026-10-21 张老师需求），点击弹 flop 播放器播放本录像。
 *  试玩（二十一期，2026-10-21 张老师需求）——一键直达全屏试玩（等价点全屏
 *  按钮后再点笑脸），锁定本录像布雷不可更改；首点自动 fetch+起播再进全屏。
 *  图标＝手柄（游戏手柄＝亲手玩一盘的语义，与播放三角/下载箭头区分）。 */
export function VideoReplayButton() {
  const ctx = useContext(ReplayCtx);
  if (!ctx) return null;
  const { status } = ctx;
  const label = status === "loading" ? "加载中…" : status === "idle" ? "播放" : "重播";
  return (
    <>
      <span className="tip_host">
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
        {/* 旧版播放器气泡（2026-10-21 张老师需求）：hover 播放按钮时下方弹深灰
            气泡，点击弹 flop 播放器（ctx.playLegacy）。span.tip_host 包按钮做
            hover 联动锚（气泡是 host 后代，hover 气泡不闪断）；点击 stopPropagation
            防触发按钮自身的原地回播。加载中隐藏（按钮此时禁用，入口无意义） */}
        <span
          className="tip_bubble"
          role="button"
          tabIndex={0}
          aria-label="使用Flop Player播放本录像"
          onClick={(e) => {
            e.stopPropagation();
            if (status !== "loading") ctx.playLegacy();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (status !== "loading") ctx.playLegacy();
            }
          }}
        >
          使用Flop Player播放
        </span>
      </span>
      <button
        type="button"
        onClick={ctx.playGame}
        disabled={status === "loading"}
        title="全屏试玩本局盘面（锁定本录像布雷，不计成绩不上传）"
      >
        <svg className="btn_icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {/* 手柄主体 + 叉键 + 两键——「亲手玩」语义 */}
          <path d="M7.5 7h9a5.5 5.5 0 0 1 5.35 4.25l.9 4.2a2.6 2.6 0 0 1-4.62 2.2l-1.42-1.9a1.5 1.5 0 0 0-1.2-.6H8.49a1.5 1.5 0 0 0-1.2.6l-1.42 1.9a2.6 2.6 0 0 1-4.62-2.2l.9-4.2A5.5 5.5 0 0 1 7.5 7z" />
          <path d="M8 10.2v3.6M6.2 12h3.6" />
          <path d="M15.8 11.2h.01M18 13.4h.01" />
        </svg>
        试玩
      </button>
    </>
  );
}
