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
};
type BoardResponse = Board & { token: string };

/* 格子 → FlopSprites symbol（与 Board.tsx VEC_SYM / 练习页 VEC_MAP 同源口径）：
   未开=cell-normal-solid、旗=cell-flag-solid、已开=cell-number-N；
   按住未开格下沉＝cell-number-0（flop/练习页 pressPaint 同语义） */
function cellSymbol(cell: Cell, pressed: boolean): string {
  if (cell.state === 1) return `cell-number-${cell.num ?? 0}`;
  if (cell.state === 2) return "cell-flag-solid";
  return pressed ? "cell-number-0" : "cell-normal-solid";
}
/* td 语义类（对齐 legacy 雪碧图 td.bb/bf/b0-b8；vec 模式下只担命中与光标形态） */
function cellClass(cell: Cell): string {
  if (cell.state === 1) return `b${cell.num ?? 0}`;
  if (cell.state === 2) return "bf";
  return "bb";
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
  /* 按压视觉：鼠标左键按住的未开格（flop 同款下沉），mouseup 全局释放 */
  const [press, setPress] = useState<number | null>(null);

  useEffect(() => {
    if (press === null) return;
    const clear = () => setPress(null);
    window.addEventListener("mouseup", clear);
    return () => window.removeEventListener("mouseup", clear);
  }, [press]);

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
    // 独立验证页关闭后不能停在空壳页；回 canonical 列表，避免筛选地址再次跳转形成循环。
    if (standalone) window.location.replace("/video");
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
      const res = await fetch("/api/bot/challenge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, action, cell }),
        cache: "no-store",
      });
      if (res.status === 410) {
        await load();
        return;
      }
      if (!res.ok) throw new Error("操作失败，请重试");
      const data = await res.json() as BoardResponse;
      token.current = data.token;
      setBoard(data);
      if (data.won) {
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
                            if (e.button === 0 && cell.state === 0 && !dead) setPress(i);
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
                  href={`#${cellSymbol(cell, press === i)}`}
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
