"use client";

import { useEffect, useRef, useState } from "react";
import type { CaptchaAction } from "@/core/src/lib/captcha-board";

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
    setBoard(null);
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
      return passed ? original(input, init) : response;
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
  return (
    <div className="mscap_overlay" role="presentation">
      <section className="mscap_modal" role="dialog" aria-modal="true" aria-labelledby="mscap_title">
        <button type="button" className="mscap_close" onClick={close} aria-label="关闭验证">×</button>
        <h2 id="mscap_title">扫一盘，继续访问</h2>
        <p className="mscap_desc">初级微型局，已自动 opening。扫完全部安全格即通过；可无限换局。</p>
        {board && (
          <div className="mscap_meta">
            <span>3BV {board.board3bv}</span>
            <span>10 雷</span>
            <span>{board.won ? "验证通过" : board.lost ? "踩雷了，换一局再试" : "左键开格 / 右键插旗 / 点数字 chord"}</span>
          </div>
        )}
        {board && (
          <div
            className={"mscap_board" + (board.won ? " won" : board.lost ? " lost" : "")}
            style={{ gridTemplateColumns: `repeat(${board.width}, 28px)` }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {board.cells.map((cell, i) => (
              <button
                type="button"
                key={i}
                className={`mscap_cell s${cell.state} n${cell.num ?? "x"}`}
                disabled={busy || board.won || board.lost}
                aria-label={`${Math.floor(i / board.width) + 1} 行 ${(i % board.width) + 1} 列`}
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
              >
                {cell.state === 1 ? (cell.num === 0 ? "" : cell.num) : cell.state === 2 ? "F" : ""}
              </button>
            ))}
          </div>
        )}
        {busy && !board && <p className="mscap_status">正在取一张预生成盘面…</p>}
        {error && <p className="mscap_error">{error}</p>}
        <div className="mscap_actions">
          <button type="button" onClick={() => void load()} disabled={busy}>换一局</button>
          <span>通过后 2 小时内免验证</span>
        </div>
      </section>
    </div>
  );
}
