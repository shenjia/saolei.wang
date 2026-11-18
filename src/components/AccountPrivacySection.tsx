// 账户设置 · 隐私设置页表单（2026-11-18 张老师需求 5，同日 23:06 提为独立页）：
// 五个滑块开关（在主页展示年龄/星座 + 公开关注/粉丝列表 + 新粉丝提醒）+
// 黑名单输入框（每行一个用户 ID，placeholder 只放「每行一个用户ID」）。
// 开关走 /api/account/visibility（age/constellation 沿用 11-10 组、
// followList/followerList/followNotify 走 /api/account/privacy 组）；
// 黑名单走 /api/account/blocklist 独立保存按钮。交互全客户端。

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
  label,
  switchText,
  initialHidden,
  hint,
  group,
}: {
  /** visibility 组（age/constellation）或 privacy 组（followList/followerList/followNotify） */
  field: VisField | PrivField;
  label: string;
  switchText: string;
  initialHidden: boolean;
  /** 开关下的小字说明 */
  hint?: string;
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
    <tr>
      <th>{label}</th>
      <td>
        <div className="acct_privacy_cell">
          <label className="acct_gsw acct_row_gsw">
            <input type="checkbox" checked={!hidden} disabled={busy} onChange={() => void toggle()} />
            <span className="track" />
            <span className="txt">{switchText}</span>
          </label>
          {hint && <p className="acct_privacy_hint">{hint}</p>}
        </div>
      </td>
    </tr>
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
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          <PrivacyToggle
            group="vis"
            field="age"
            label="年龄"
            switchText="在主页展示年龄"
            initialHidden={flags.ageHidden}
            hint="关闭后个人主页资料不显示年龄行"
          />
          <PrivacyToggle
            group="vis"
            field="constellation"
            label="星座"
            switchText="在主页展示星座"
            initialHidden={flags.constellationHidden}
            hint="关闭后个人主页资料不显示星座行"
          />
          <PrivacyToggle
            group="priv"
            field="followList"
            label="关注列表"
            switchText="公开显示我的关注列表"
            initialHidden={flags.followListHidden}
            hint="关闭后其他玩家无法查看你关注了谁"
          />
          <PrivacyToggle
            group="priv"
            field="followerList"
            label="粉丝列表"
            switchText="公开显示我的粉丝列表"
            initialHidden={flags.followerListHidden}
            hint="关闭后其他玩家无法查看你的粉丝"
          />
          <PrivacyToggle
            group="priv"
            field="followNotify"
            label="新粉丝提醒"
            switchText="有新粉丝时提醒我"
            initialHidden={flags.followNotifyDisabled}
            hint="关闭后有人关注你不再收到系统消息"
          />
        </tbody>
      </table>
      <div className="acct_blocklist">
        <label className="bl_label" htmlFor="acct_blocklist_input">
          黑名单
        </label>
        <textarea
          id="acct_blocklist_input"
          className="bl_input"
          rows={4}
          value={bl}
          placeholder="每行一个用户ID"
          onChange={(e) => setBl(e.target.value)}
        />
        <p className="acct_privacy_hint bl_hint">
          名单中的用户不能给你发消息、评论你的录像、回复你的文章、关注你（保存即时生效）
        </p>
        <button type="button" className="button small bl_save" disabled={busy} onClick={() => void saveBlocklist()}>
          保存黑名单
        </button>
      </div>
    </div>
  );
}
