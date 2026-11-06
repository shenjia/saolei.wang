"use client";

// 首页更新通告浮层（2026-11-06 张老师要求）：登录用户进首页弹出最近更新历史，
// 列表带细滚动条可下滚查看更多历史。「知道了」关闭浮层并把最新更新日期写入
// localStorage（yyyymmdd 数值），此后仅当出现更大日期的新纪录才再次弹出；
// 「提交意见建议」就地切换给站长（张砷镓 id:1）发站内信的面板，走 /api/message
// send 通道（敏感词 / 维护模式 / 收件人校验与消息页同源）。
// 浮层由 page.tsx 渲染在 #page 之外（body 直下）：#page ≤605px 有整页 zoom，
// fixed 遮罩做在里面会随缩放失真铺不满屏（同 EmailBindNotice 口径）。

import { useCallback, useEffect, useState } from "react";
import { useDraft } from "./useDraft";

const LS_KEY = "update_notice_seen"; // 值 = 最新更新日期的可比数值（yyyymmdd）
const WEBMASTER_ID = 1; // 张砷镓

export interface UpdateNoticeRow {
  id: number;
  /** 展示日期串「Y.M.D」（月/日不补零） */
  date: string;
  content: string;
}

/** 「Y.M.D」（月/日不补零）→ yyyymmdd 数值；字符串直接比会在个位日期上出错（2026.10.9 > 2026.10.29），必须数值化 */
function dateNum(s: string): number {
  const [y, m, d] = s.split(".").map(Number);
  return (y || 0) * 10000 + (m || 0) * 100 + (d || 0);
}

export function UpdateNotice({ updates, uid }: { updates: UpdateNoticeRow[]; uid: number }) {
  // "list"=历史面板 "feedback"=发信面板 "hidden"=关闭。
  // 水合前恒 hidden（服务端不渲染浮层），挂载后按 localStorage 决定是否弹出——
  // 未记录过 / 最新日期大于已记录日期 → 弹出
  const [view, setView] = useState<"list" | "feedback" | "hidden">("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  // 列表展示条数：首屏 10 条，「加载更多」每次 +10（数据全量随 props 传入，纯客户端切片）
  const [shown, setShown] = useState(10);
  const isWebmaster = uid === WEBMASTER_ID;
  // 草稿与消息页/主页气泡浮窗共用同一份（按 发件人+收件人 隔离）；站长本人无草稿
  const draft = useDraft(isWebmaster ? null : `pm:${uid}:${WEBMASTER_ID}`);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(LS_KEY)) || 0;
      const latest = Math.max(...updates.map((u) => dateNum(u.date)));
      if (latest > stored) setView("list");
    } catch {
      setView("list");
    }
  }, [updates]);

  // 浮层显示时锁页面滚动（与登录浮窗/邮箱提醒浮层同款）
  useEffect(() => {
    if (view === "hidden") return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [view]);

  /** 「知道了」：把最新更新日期计入 localStorage 后关闭 */
  const onGotIt = useCallback(() => {
    try {
      const latest = Math.max(...updates.map((u) => dateNum(u.date)));
      localStorage.setItem(LS_KEY, String(latest));
    } catch {
      /* 隐私模式写不进：仅本次关闭 */
    }
    setView("hidden");
  }, [updates]);

  async function onSend() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: WEBMASTER_ID, content: draft.value }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "发送失败");
      return;
    }
    setSent(true);
    draft.clear();
  }

  if (view === "hidden") return null;

  return (
    <div className="login_overlay update_notice_overlay">
      <div className="update_notice_modal">
        {view === "list" ? (
          <>
            <h3>最近更新</h3>
            <div className="un_list">
              {updates.slice(0, shown).map((u) => (
                <p key={u.id}>
                  <em>{u.date}</em>
                  {u.content}
                </p>
              ))}
              {/* 滚到最底部：标准翻页控件同款三圆点「加载更多」+ 剩余条数
                  （2026-11-06 三轮张老师要求，替代原「查看全部」链接） */}
              {shown < updates.length && (
                <div className="un_more">
                  <button
                    type="button"
                    className="dots_more"
                    title="加载更多"
                    onClick={() => setShown(Math.min(shown + 10, updates.length))}
                  >
                    <i />
                    <i />
                    <i />
                  </button>
                  <span className="un_more_txt">
                    还有 <b>{updates.length - shown}</b> 条更新日志
                  </span>
                </div>
              )}
            </div>
            <div className="btns">
              <button type="button" className="btn_primary" onClick={onGotIt}>
                知道了
              </button>
              <button
                type="button"
                className="btn_later"
                onClick={() => {
                  setError("");
                  setView("feedback");
                }}
              >
                提交意见建议
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>提交意见建议</h3>
            <p className="un_to">
              发给：<em>张砷镓</em>（站长）
            </p>
            {sent ? (
              <p className="un_done">✓ 已发送，感谢您的反馈！</p>
            ) : isWebmaster ? (
              <p className="un_done">站长本人登录，无需提交反馈</p>
            ) : (
              <textarea
                className="un_input"
                rows={5}
                maxLength={200}
                placeholder="说点什么…（200 字以内）"
                value={draft.value}
                onChange={(e) => draft.set(e.target.value)}
              />
            )}
            {!sent && !isWebmaster && <p className="un_error">{error}</p>}
            <div className="btns">
              {sent ? (
                <button type="button" className="btn_primary" onClick={onGotIt}>
                  知道了
                </button>
              ) : (
                <button
                  type="button"
                  className="btn_primary"
                  disabled={busy || isWebmaster || !draft.value.trim()}
                  onClick={onSend}
                >
                  发送
                </button>
              )}
              <button
                type="button"
                className="btn_later"
                onClick={() => {
                  setError("");
                  setView("list");
                }}
              >
                返回
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
