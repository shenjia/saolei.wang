"use client";

// 录像详情页原地回放（2026-10-15 张老师需求：点播放后棋盘原地进行回放，
// 复用在线练习自研回放的引擎口径——事件重演 + 光标插值 + 进即自动播完（固定 1x）。
//
// 数据：avf/mvf 解析器（与上传页浏览器端同一套，Uint8Array 入参，不碰 Buffer）；
// rmv / 解析失败 / 尺寸不符 → 兜底懒挂 flop 播放器（playFlop 全屏播放）。
//
// 事件应用口径（2026-10-15 二轮修正：以终态盘 ground truth 网格搜索锁定，
// 22 盘胜局全开 + 338799 判死验证；此前照抄 videoradar 配对导致 344834 大量格子不开）：
//   左击 → 挂起，lr 松开时以**松开坐标**开格/chord（首击按下坐标失真，一律取松开）；
//   右键 → rc 按下即刻以**按下坐标**插旗/拔旗（按下即落子，非松开）；
//   双键 chord（任一键在另一键按住时按下）→ 上膛，**后松开时**以该次松开坐标生效；
//   孤 lr ＝ 首击（Arbiter 有时首击只记松开，按下在流外）；
//   尾部未松开的 lc 按按下坐标补记（fatal click 无松开，踩雷局靠此判死即时揭示）。

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
}

/** avf/mvf 二进制 → 回放数据；不可解析返回 null（调用方走 flop 兜底） */
function parseReplayData(buf: Uint8Array, ext: string): ReplayData | null {
  let lines: string[] | null = null;
  try {
    lines = ext === "avf" ? avfToRawvf(buf) : ext === "mvf" ? mvfToRawvf(buf) : null;
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
    const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
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
    // 终点取「最后事件」与「库内用时」的较大者：最后开格后计时器还走着，
    // 停在 timeMs 与真实对局节奏一致（练习页引擎用 s.csec 同理）
    totalCsec: Math.max(lastCsec, Math.round(v.timeMs / 10)),
  };
}

/* ---- 回放引擎（结构对齐练习页 OnlinePlay.startInPlaceReplay）---- */

interface Engine {
  restart: () => void;
  stop: () => void;
}

function runReplay(opts: {
  wrap: HTMLElement;
  tbody: HTMLTableSectionElement;
  rows: number;
  cols: number;
  data: ReplayData;
  onEnd: () => void;
}): Engine {
  const { wrap, tbody, rows, cols, data, onEnd } = opts;
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
  /* 回放状态机（0 未开 / 1 开 / 2 旗）+ 原图类名备份（stop 恢复静态地图） */
  const rstate = new Uint8Array(N);
  const saved = new Array<string>(N);
  const cellTd = (i: number) => tbody.rows[(i / cols) | 0].cells[i % cols];
  for (let i = 0; i < N; i++) saved[i] = cellTd(i).className;
  function paintR(i: number) {
    const td = cellTd(i);
    let cls = "bb";
    if (rstate[i] === 1) cls = "b" + nums[i];
    else if (rstate[i] === 2) cls = "bf";
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
  function chordR(i: number) {
    if (rstate[i] !== 1 || nums[i] === 0) return;
    const around = nbR(i);
    let fc = 0;
    for (const a of around) if (rstate[a] === 2) fc++;
    if (fc !== nums[i]) return;
    for (const a of around) if (rstate[a] === 0) {
      if (mines[a]) {
        hitIdx = a;
        dead = true;
        revealLoss();
        return;
      }
      floodR(a);
    }
  }
  /* 回放光标：flop 同款箭头（#cursor-arrow，FlopSprites 已内置；练习页同款 .replay_cursor）。
     箭头坐标域 0-120 × 0-190、尖端 (5,12)——事件像素坐标对准尖端。
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
  const TIP_X = 5,
    TIP_Y = 12;
  function moveCursor(px: number, py: number) {
    curEl.style.left = px + off.x - TIP_X + "px";
    curEl.style.top = py + off.y - TIP_Y + "px";
  }
  /* 事件应用：双键状态机（2026-10-15 二轮修正口径，见文件头注释） */
  const evs = data.evs;
  let lDown = false;
  let rDown = false;
  let armed = false; // 双键 chord 已上膛（armedX/Y＝第二键按下坐标）
  let armedX = 0;
  let armedY = 0;
  let gestureL = false; // 本次按入属双键手势（松开时吞掉，不触发孤 lr 首击）
  let pendL = -1; // 挂起左击（按下事件下标），松开时以松开坐标生效
  let dead = false; // 踩雷：对局即时结束（雷区已揭示），后续事件只动光标
  let hitIdx = -1;
  const inb = (px: number, py: number) => px >= 0 && py >= 0 && px < cols * 16 && py < rows * 16;
  const idxOf = (px: number, py: number) => ((py / 16) | 0) * cols + ((px / 16) | 0);
  function chordAt(px: number, py: number) {
    if (inb(px, py)) chordR(idxOf(px, py));
  }
  /* 败局雷区揭示（踩雷瞬间；位图类：bc=踩中红叉雷 / bm=雷 / bn=错旗） */
  function revealLoss() {
    for (let i = 0; i < N; i++) {
      if (mines[i]) {
        if (rstate[i] !== 2) cellTd(i).className = i === hitIdx ? "bc" : "bm";
      } else if (rstate[i] === 2) {
        cellTd(i).className = "bn";
      }
    }
  }
  function leftAt(px: number, py: number) {
    if (!inb(px, py)) return;
    const i = idxOf(px, py);
    if (rstate[i] === 1) chordR(i);
    else if (rstate[i] === 0) {
      if (mines[i]) {
        hitIdx = i;
        dead = true;
        revealLoss();
        return;
      }
      floodR(i);
    }
    // 落在旗格：无效果（与引擎/Clone 一致）
  }
  function rightAt(px: number, py: number) {
    if (!inb(px, py)) return;
    const i = idxOf(px, py);
    if (rstate[i] === 0) {
      rstate[i] = 2;
      paintR(i);
    } else if (rstate[i] === 2) {
      rstate[i] = 0;
      paintR(i);
    }
  }
  function applyEv(k: number) {
    const e = evs[k];
    moveCursor(e.px, e.py);
    if (dead) return;
    if (e.ev === "lc") {
      if (rDown) {
        // 双键 chord：左键按入时右键已按住 → 上膛（后松开时以松开坐标生效）
        armed = true;
        armedX = e.px;
        armedY = e.py;
        lDown = true;
        gestureL = true;
      } else {
        // 残缺保险：上次按下没等到松开又按下——先按按下坐标补记，免得整次操作丢失
        if (pendL >= 0) leftAt(evs[pendL].px, evs[pendL].py);
        lDown = true;
        pendL = k;
      }
    } else if (e.ev === "lr") {
      lDown = false;
      if (armed) {
        chordAt(e.px, e.py); // 双键 chord：后松开时生效，作用格＝该次松开坐标
        armed = false;
        pendL = -1;
      } else if (pendL >= 0) {
        leftAt(e.px, e.py); // 命中格取松开位置（首击按下坐标失真，同理）
        pendL = -1;
      } else if (!gestureL) {
        leftAt(e.px, e.py); // 孤 lr＝首击（Arbiter 有时首击只记松开，按下在流外）
      }
      gestureL = false;
    } else if (e.ev === "rc") {
      if (lDown) {
        // 双键 chord：右键按入时左键已按住 → 上膛（不插旗，手势一体）
        armed = true;
        armedX = e.px;
        armedY = e.py;
        rDown = true;
      } else {
        rDown = true;
        rightAt(e.px, e.py); // 旗：按下即刻生效（按下坐标）
      }
    } else if (e.ev === "rr") {
      rDown = false;
      if (armed) {
        chordAt(e.px, e.py); // 双键 chord：后松开时生效
        armed = false;
        pendL = -1;
      }
    } else if (e.ev === "sc" || e.ev === "mc") {
      chordAt(e.px, e.py);
    }
  }
  /* rAF 驱动（进即自动播完、固定 1x——练习页六期口径；回放中再触发＝从头重播） */
  let evIdx = 0;
  let curCsec = 0;
  let playing = false;
  let rafId: number | null = null;
  let lastFrame = 0;
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
    lDown = rDown = armed = false;
    gestureL = false;
    armedX = armedY = 0;
    pendL = -1;
    dead = false;
    hitIdx = -1;
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
      /* 尾部补记：录像在按下后直接结束（没记录松开）——按按下坐标补记。
         fatal click（踩雷）正是这种形态，踩雷局靠此判死即时揭示；
         双键 chord 手势截尾则按第二键按下坐标补 chord（videoradar 尾部兜底同款） */
      if (!dead) {
        if (pendL >= 0) leftAt(evs[pendL].px, evs[pendL].py);
        else if (armed) chordAt(armedX, armedY);
      }
      onEnd(); // 定格终局画面（练习页桌面口径）；退出由棋盘点击 / Esc / stop 负责
      return;
    }
    rafId = requestAnimationFrame(tick);
  }
  resetReplay();
  setPlaying(true);
  return {
    restart() {
      setPlaying(false);
      resetReplay();
      setPlaying(true);
    },
    stop() {
      setPlaying(false);
      curEl.remove();
      for (let i = 0; i < N; i++) cellTd(i).className = saved[i];
    },
  };
}

/* ---- React 外壳：Provider（引擎/缓存/flop 兜底）+ Board + Button ---- */

type Status = "idle" | "loading" | "playing" | "ended";

interface ReplayCtxValue {
  status: Status;
  play: () => void;
  stop: () => void;
}

const ReplayCtx = createContext<ReplayCtxValue | null>(null);

export function VideoReplayProvider({
  boardId,
  filepath,
  children,
}: {
  /** Board 组件渲染的 id="board_{boardId}"，play() 时据此定位棋盘 DOM */
  boardId: number;
  filepath: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<Status>("idle");
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
    if (ext !== "avf" && ext !== "mvf") {
      // rmf/rmv 等站内无解析器的格式 → flop 播放器兜底
      setFlopUri(uri);
      return;
    }
    setStatus("loading");
    void (async () => {
      try {
        if (dataRef.current === undefined) {
          const res = await fetch(uri);
          if (!res.ok) throw new Error(String(res.status));
          dataRef.current = parseReplayData(new Uint8Array(await res.arrayBuffer()), ext);
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
        });
        setStatus("playing");
      } catch {
        dataRef.current = null;
        setStatus("idle");
        setFlopUri(uri);
      }
    })();
  }, [boardId, filepath, uri]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    setStatus("idle");
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
    <ReplayCtx.Provider value={{ status, play, stop }}>
      {children}
      {/* 光标贴图定义（隐藏 svg defs，含 #cursor-arrow） */}
      <FlopSprites />
      {flopUri && <FlopPlayer />}
    </ReplayCtx.Provider>
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
