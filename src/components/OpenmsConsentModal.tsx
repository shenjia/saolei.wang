"use client";
// 开源扫雷网同步征求弹窗（2026-11-07 张老师需求；11-08 改版：站内标准遮罩浮层样式）
// 仅绑定开源站且未表态的用户可见（layout 服务端判定 consent===0 渲染）；
// 2026-11-13 全天可表态，之后（11-14 00:00 起）不再提醒——时间判定放客户端，
// 避免 RSC 渲染期取 Date.now()（工程铁律）。
// 视觉复用邮箱绑定提醒同款标准弹窗（.login_overlay + .email_bind_modal，
// 黄=同意 / 灰=不同意，色板零新色）；浮现时锁页面滚动（同 EmailBindNotice）。
import { useEffect, useState } from "react";
import { toast } from "@/components/Toast";

/** 表态截止：2026-11-14 00:00:00 +08:00（与 lib/openms.ts 同源，客户端需 ms） */
const DEADLINE_MS = 1794585600 * 1000;

export function OpenmsConsentModal() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Date.now() < DEADLINE_MS) setVisible(true);
  }, []);

  // 浮层显示时锁页面滚动（与登录浮窗/邮箱绑定提醒同款）
  useEffect(() => {
    if (!visible) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [visible]);

  async function choose(choice: "agree" | "disagree") {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/openms/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice }),
      });
      if (r.ok) {
        toast(choice === "agree" ? "已记录：同意同步" : "已记录：不同意同步，历史录像将不会同步", "success");
        setVisible(false);
        return;
      }
      toast("提交失败，请稍后重试", "error");
    } catch {
      toast("网络异常，请稍后重试", "error");
    }
    setBusy(false);
  }

  if (!visible) return null;
  return (
    <div className="login_overlay openms_consent_overlay" role="dialog" aria-label="开源扫雷网录像同步征求">
      <div className="email_bind_modal">
        <p className="text">
          您已在开源扫雷网（openms.top）绑定了扫雷网账户
          <br />
          是否同意把开源网上未收录的历史录像<b>同步到扫雷网</b>？
          <br />
          <span style={{ fontSize: 13, color: "#b1b1a4" }}>
            同步计划在11月13日进行，如届时您仍未表态，视为默认同意。
          </span>
        </p>
        <div className="btns">
          <button
            type="button"
            className="btn_primary"
            disabled={busy}
            onClick={() => choose("agree")}
          >
            同意
          </button>
          <button
            type="button"
            className="btn_later"
            disabled={busy}
            onClick={() => choose("disagree")}
          >
            不同意
          </button>
        </div>
      </div>
    </div>
  );
}
