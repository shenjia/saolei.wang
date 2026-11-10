"use client";

import { useEffect, useRef, useState } from "react";
import type { CaptchaAction } from "@/core/src/lib/captcha-board";
import { FlopSprites } from "./FlopSprites";
import { LoginLink } from "./LoginLink";
import { toast } from "./Toast";

type Cell = { state: number; num: number | null };
type Board = {
  width: number;
  height: number;
  board3bv: number;
  won: boolean;
  lost: boolean;
  moves: number;
  cells: Cell[];
  /** 踩雷时 API 回传的触发雷格（open=所点格；chord=邻域首个未开雷），画红底爆雷 */
  mineCell?: number;
};
type BoardResponse = Board & { token: string };
/* 增量协议 v2（2026-11-10 张老师：每步 2.8KB 太费）：PUT 带 base 状态串，
   响应 diff 形态时本地合并；全量（无 diff 字段）直接整体替换（回落兼容）。 */
type DeltaResponse = {
  token: string;
  width: number;
  height: number;
  board3bv: number;
  won: boolean;
  lost: boolean;
  moves: number;
  diff?: Array<{ i: number; s: number; n: number | null }>;
  mineCell?: number;
} & Partial<Board>;

function applyDelta(base: Board, data: DeltaResponse): Board {
  if (!data.diff || !data.cells === false) {
    // 全量形态：cells 存在（或 diff 缺失）→ 整体替换
    const full = data as BoardResponse & { cells: Cell[] };
    if (full.cells) return full;
  }
  if (!data.diff) throw new Error("响应缺 diff");
  const cells = base.cells.slice();
  for (const c of data.diff) cells[c.i] = { state: c.s, num: c.n };
  return {
    width: data.width,
    height: data.height,
    board3bv: data.board3bv,
    won: data.won,
    lost: data.lost,
    moves: data.moves,
    cells,
    ...(data.mineCell !== undefined ? { mineCell: data.mineCell } : {}),
  };
}

/* 格子 → FlopSprites symbol（与 Board.tsx VEC_SYM / 练习页 VEC_MAP 同源口径）：
   未开=cell-normal-solid、旗=cell-flag-solid、已开=cell-number-N；
   按住未开格下沉＝cell-number-0（flop/练习页 pressPaint 同语义）；
   踩雷触发格＝cell-mine-bomb 红底炸雷（2026-11-10 张老师：外框变红不够醒目） */
function cellSymbol(cell: Cell, i: number, mineCell: number, pressed: boolean): string {
  if (cell.state === 1) return `cell-number-${cell.num ?? 0}`;
  if (i === mineCell) return "cell-mine-bomb";
  if (cell.state === 2) return "cell-flag-solid";
  return pressed ? "cell-number-0" : "cell-normal-solid";
}
/* td 语义类（对齐 legacy 雪碧图 td.bb/bf/b0-b8；vec 模式下只担命中与光标形态） */
function cellClass(cell: Cell): string {
  if (cell.state === 1) return `b${cell.num ?? 0}`;
  if (cell.state === 2) return "bf";
  return "bb";
}

/* chord 按压集合：数字格 i 周围 8 格中未开且未插旗的（旗保持原样） */
function chordSet(board: Board, i: number): Set<number> {
  const next = new Set<number>();
  const x = i % board.width;
  const y = Math.floor(i / board.width);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= board.width || ny < 0 || ny >= board.height) continue;
      const j = ny * board.width + nx;
      if (board.cells[j].state === 0) next.add(j);
    }
  }
  return next;
}

export function BotChallengeGate() {
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const token = useRef("");
  const waiters = useRef<Array<(ok: boolean) => void>>([]);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const redirect = useRef<string | null>(null);
  /* 按压视觉（2026-11-10 张老师：chord 按压预览对齐经典扫雷）：左键按住
     未开格＝该格下沉；按住已开数字格＝周围 8 格中未开且未插旗的同步下沉
     （已标旗保持原样）。按住期间在数字格间移动光标，按压区域随落点重算
     （落点不是数字格则全部释放）；mouseup 释放后 click 才走 chord */
  const [press, setPress] = useState<ReadonlySet<number>>(new Set());
  const dragChord = useRef(false);
  /* mousemove 闭包要读最新盘面（换局后 board 引用变），用 ref 镜像 */
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;

  useEffect(() => {
    /* 拖拽跟踪期间监听常挂（按 press.size 早退会在拖过非数字格、按压清空的
       瞬间卸载监听，拖回数字格无法恢复跟踪）；组件卸载/弹窗关闭时收尾 */
    if (!open) return;
    const clear = () => {
      dragChord.current = false;
      setPress(new Set());
    };
    const move = (e: MouseEvent) => {
      if (!dragChord.current || !boardRef.current) return;
      /* ⚠️ WebKit zoom 子树 gBCR 不可信（项目铁律）——落点判定用
         elementFromPoint，坐标来自 MouseEvent 本身不经 gBCR */
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const td = t?.closest?.(".mscap_board td");
      if (!td) {
        setPress(new Set());
        return;
      }
      const i = Number((td as HTMLTableCellElement).dataset.i);
      const b = boardRef.current;
      setPress(b.cells[i].state === 1 ? chordSet(b, i) : new Set<number>());
    };
    window.addEventListener("mouseup", clear);
    window.addEventListener("mousemove", move);
    return () => {
      window.removeEventListener("mouseup", clear);
      window.removeEventListener("mousemove", move);
    };
  }, [open]);

  function settle(ok: boolean) {
    for (const resolve of waiters.current.splice(0)) resolve(ok);
  }

  function close() {
    const standalone = redirect.current !== null;
    settle(false);
    redirect.current = null;
    setOpen(false);
    setBoard(null);
    setError("");
    // 独立验证页关闭后不能停在空壳页；也不能去可能再撞闸的固定地址（全站文档
    // 已设匿名闸）——回上一页＝「当无事发生」，无历史（新标签直达）才回首页
    // （首页预热常暖，不再触发闸）。
    if (standalone) {
      if (window.history.length > 1) window.history.back();
      else window.location.replace("/");
    }
  }

  async function load() {
    setBusy(true);
    setError("");
    // 不清空旧盘面：换局时旧局原地保留，新局到达后整盘替换（避免弹窗高度塌缩跳动）
    try {
      const res = await fetch("/api/bot/challenge", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error("开局失败，请重试");
      const data = await res.json() as BoardResponse;
      token.current = data.token;
      setBoard(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (open && !board && !busy && !error) void load();
    // load 只在弹窗首次打开时触发；换局由按钮显式调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await original(input, init);
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url, window.location.href);
      const rsc = request.headers.get("rsc") === "1" || url.searchParams.has("_rsc");
      const prefetch = request.headers.get("next-router-prefetch") === "1" ||
        request.headers.has("next-router-segment-prefetch") ||
        /prefetch/i.test(request.headers.get("purpose") ?? request.headers.get("sec-purpose") ?? "");
      if (!rsc || prefetch || response.status !== 403 || response.headers.get("x-saolei-challenge") !== "minesweeper") {
        return response;
      }
      setOpen(true);
      const passed = await new Promise<boolean>((resolve) => waiters.current.push(resolve));
      if (passed) return original(input, init);
      // 关闭＝当无事发生：绝不能把 403 还给路由——Next 对非 200 的 RSC 响应会
      // doMpaNavigation 整页跳到目的页（文档请求不设闸，等于关掉弹窗就绕过验证）。
      // 在此 reject：navigateToUnknownRoute 的 catch 会吞掉错误，导航静默中止、留在当前页。
      throw new DOMException("challenge dismissed", "AbortError");
    };
    return () => {
      window.fetch = original;
      settle(false);
    };
  }, []);

  useEffect(() => {
    function onChallenge(event: Event) {
      const next = (event as CustomEvent<{ next?: string }>).detail?.next;
      redirect.current = next?.startsWith("/") && !next.startsWith("//") ? next : "/video";
      setOpen(true);
    }
    window.addEventListener("app:minesweeper-challenge", onChallenge);
    return () => window.removeEventListener("app:minesweeper-challenge", onChallenge);
  }, []);

  async function act(action: CaptchaAction, cell: number) {
    if (!board || busy || board.won || board.lost) return;
    setBusy(true);
    setError("");
    try {
      const base = board.cells.map((c) => c.state).join("");
      const res = await fetch("/api/bot/challenge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, action, cell, base }),
        cache: "no-store",
      });
      if (res.status === 410) {
        await load();
        return;
      }
      if (!res.ok) throw new Error("操作失败，请重试");
      const data = await res.json() as DeltaResponse;
      token.current = data.token;
      const next = applyDelta(board, data);
      if (next.lost && data.mineCell === undefined) next.mineCell = board.mineCell;
      setBoard(next);
      if (next.won) {
        toast("验证成功", "success");
        const target = redirect.current;
        redirect.current = null;
        settle(true);
        setTimeout(() => {
          if (target) window.location.replace(target);
          else {
            setOpen(false);
            setBoard(null);
          }
        }, 650);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const face = board?.won ? "face-win" : board?.lost ? "face-lose" : "face-flat";
  return (
    <div className="mscap_overlay" role="presentation">
      <section className="mscap_modal" role="dialog" aria-modal="true" aria-labelledby="mscap_title">
        <button type="button" className="mscap_close" onClick={close} aria-label="关闭验证">×</button>
        <h2 id="mscap_title">扫盘初级，证明你是真人</h2>
        {/* 换局按钮：首页「开始练习」同款扁平笑脸银灰凸起（flop 四态笑脸：胜=墨镜/负=僵尸） */}
        {/* 宽度与游戏区域一致：棋盘渲染宽 = cols×16 + 左右 2px 边框，zoom 1.5 等比 */}
        <button
          type="button"
          className="mscap_face"
          style={board ? { width: (board.width * 16 + 4) * 1.5 } : undefined}
          onClick={() => void load()}
          disabled={busy}
        >
          <svg viewBox="0 0 260 260" width={24} height={24} aria-hidden="true">
            <use href={`#${face}`} />
          </svg>
          <span>换一局</span>
        </button>
        {board && (
          <div
            className={
              "mscap_board board size16 vec" +
              (board.won ? " won" : board.lost ? " lost" : "")
            }
            onContextMenu={(e) => e.preventDefault()}
          >
            <table cellPadding={0} cellSpacing={0}>
              <tbody>
                {Array.from({ length: board.height }, (_, y) => (
                  <tr key={y}>
                    {board.cells.slice(y * board.width, (y + 1) * board.width).map((cell, x) => {
                      const i = y * board.width + x;
                      const dead = busy || board.won || board.lost;
                      return (
                        <td
                          key={x}
                          className={cellClass(cell)}
                          aria-label={`${y + 1} 行 ${x + 1} 列`}
                          data-i={i}
                          onClick={() => {
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            void act(cell.state === 1 ? "chord" : "open", i);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            void act("flag", i);
                          }}
                          onMouseDown={(e) => {
                            if (e.button !== 0 || dead) return;
                            if (cell.state === 0) {
                              dragChord.current = false;
                              setPress(new Set([i]));
                              return;
                            }
                            /* 按住已开数字格＝chord 按压预览，开启拖拽跟踪 */
                            if (cell.state === 1) {
                              dragChord.current = true;
                              setPress(chordSet(board, i));
                            }
                          }}
                          onTouchStart={() => {
                            longPress.current = setTimeout(() => {
                              suppressClick.current = true;
                              void act("flag", i);
                            }, 480);
                          }}
                          onTouchEnd={() => {
                            if (longPress.current) clearTimeout(longPress.current);
                            longPress.current = null;
                          }}
                          onTouchCancel={() => {
                            if (longPress.current) clearTimeout(longPress.current);
                            longPress.current = null;
                          }}
                        ></td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 整盘单 SVG 覆盖层（详情页/回放 vec 同构）：FlopSprites 贴图一次光栅化，
                zoom 放大下网格仍均匀；贴图随弹窗自带（gate 挂根 layout，宿主页未必有） */}
            <svg
              className="vecboard"
              viewBox={`0 0 ${board.width * 16} ${board.height * 16}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect x="0" y="0" width="100%" height="100%" fill="#808080" />
              {board.cells.map((cell, i) => (
                <use
                  key={i}
                  href={`#${cellSymbol(cell, i, board.mineCell ?? -1, press.has(i))}`}
                  x={(i % board.width) * 16}
                  y={((i / board.width) | 0) * 16}
                  width={16}
                  height={16}
                />
              ))}
            </svg>
            <FlopSprites />
          </div>
        )}
        {busy && !board && <p className="mscap_status">正在取一张预生成盘面…</p>}
        {error && <p className="mscap_error">{error}</p>}
        <p className="mscap_note">
          完成后<span className="mscap_gold"> 2 </span>小时免验证，
          <LoginLink>登录</LoginLink>后不再出现此提示
        </p>
      </section>
    </div>
  );
}
