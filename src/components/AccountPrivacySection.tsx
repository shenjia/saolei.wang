// 账户设置 · 隐私设置页表单（2026-11-18 张老师需求 5，23:28 四改）：
// 五个滑块开关（开关文案自释：在主页展示年龄/星座、公开显示我的关注/粉丝列表、
// 有新粉丝时提醒我）+ 黑名单输入框（小标题样式 + 每行一个用户ID + 保存按钮）。
// 23:28 张老师定：去「隐私设置」小标题、开关行不放标签名、去小字提示。
// 开关走 /api/account/visibility（age/constellation）与 /api/account/privacy
// （followList/followerList/followNotify）；黑名单 /api/account/blocklist
// （保存即双向解除与名单用户的关注关系）。交互全客户端。

"use client";

import { useState } from "react";
import { toast } from "./Toast";

export interface PrivacyFlags {
  /** 主页展示年龄（true=隐藏；语义同 ageHidden） */
  ageHidden: boolean;
  /** 主页展示星座（true=隐藏；语义同 constellationHidden） */
  constellationHidden: boolean;
  followListHidden: boolean;
  followerListHidden: boolean;
  followNotifyDisabled: boolean;
  blocklist: string;
}

type VisField = "age" | "constellation" | "donate";
type PrivField = "followList" | "followerList" | "followNotify";

function PrivacyToggle({
  field,
  switchText,
  initialHidden,
  group,
}: {
  /** visibility 组（age/constellation）或 privacy 组（followList/followerList/followNotify） */
  field: VisField | PrivField;
  switchText: string;
  initialHidden: boolean;
  /** API 分组：vis=/api/account/visibility，priv=/api/account/privacy */
  group: "vis" | "priv";
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    const next = !hidden;
    setBusy(true);
    setHidden(next);
    try {
      const res = await fetch(group === "vis" ? "/api/account/visibility" : "/api/account/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, hidden: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setHidden(!next);
        toast(data.error ?? "保存失败，请重试", "error");
      } else {
        toast(next ? `已关闭「${switchText}」` : `已开启「${switchText}」`, "success");
      }
    } catch {
      setHidden(!next);
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="priv_row">
      <label className="acct_gsw acct_row_gsw">
        <input type="checkbox" checked={!hidden} disabled={busy} onChange={() => void toggle()} />
        <span className="track" />
        <span className="txt">{switchText}</span>
      </label>
    </div>
  );
}

export function AccountPrivacySection({ flags }: { flags: PrivacyFlags }) {
  const [bl, setBl] = useState(flags.blocklist);
  const [busy, setBusy] = useState(false);

  async function saveBlocklist() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/account/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ list: bl }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; count?: number; error?: string };
      if (!data.ok) {
        toast(data.error ?? "保存失败，请重试", "error");
        return;
      }
      toast(data.count ? `黑名单已保存（${data.count} 人）` : "黑名单已保存（空）", "success");
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="privacy_sec">
      <div className="priv_rows">
        <PrivacyToggle group="vis" field="age" switchText="在主页展示年龄" initialHidden={flags.ageHidden} />
        <PrivacyToggle group="vis" field="constellation" switchText="在主页展示星座" initialHidden={flags.constellationHidden} />
        <PrivacyToggle group="priv" field="followList" switchText="公开显示我的关注列表" initialHidden={flags.followListHidden} />
        <PrivacyToggle group="priv" field="followerList" switchText="公开显示我的粉丝列表" initialHidden={flags.followerListHidden} />
        <PrivacyToggle group="priv" field="followNotify" switchText="有新粉丝时提醒我" initialHidden={flags.followNotifyDisabled} />
      </div>
      <div className="acct_blocklist">
        {/* 黑名单小标题（23:28 张老师定：沿用原「隐私设置」小标题样式 privacy_title） */}
        <h3 className="privacy_title">黑名单</h3>
        <textarea
          id="acct_blocklist_input"
          className="bl_input"
          rows={4}
          value={bl}
          placeholder="每行一个用户ID"
          onChange={(e) => setBl(e.target.value)}
        />
        <button type="button" className="button small bl_save" disabled={busy} onClick={() => void saveBlocklist()}>
          保存黑名单
        </button>
      </div>
    </div>
  );
}
