// 账户设置「隐私」区（2026-11-18 张老师需求 5）：三个滑块开关（关注/粉丝列表公开、
// 新粉丝提醒）+ 底部黑名单输入框（每行一个用户 ID）。开关走 /api/account/visibility
// 的 privacy 组；黑名单走 /api/account/blocklist 独立保存按钮。
// 服务端直渲初始态（服务端组件页面里用），交互全部客户端。

"use client";

import { useState } from "react";
import { toast } from "./Toast";

export interface PrivacyFlags {
  followListHidden: boolean;
  followerListHidden: boolean;
  followNotifyDisabled: boolean;
  blocklist: string;
}

function PrivacyToggle({
  field,
  label,
  switchText,
  initialHidden,
  hint,
}: {
  field: "followList" | "followerList" | "followNotify";
  label: string;
  switchText: string;
  initialHidden: boolean;
  /** 开关下的小字说明 */
  hint?: string;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    const next = !hidden;
    setBusy(true);
    setHidden(next);
    try {
      const res = await fetch("/api/account/visibility", {
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
      <hr />
      <h3 className="privacy_title">隐私</h3>
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          <PrivacyToggle
            field="followList"
            label="关注列表"
            switchText="公开显示我的关注列表"
            initialHidden={flags.followListHidden}
            hint="关闭后其他玩家无法查看你关注了谁"
          />
          <PrivacyToggle
            field="followerList"
            label="粉丝列表"
            switchText="公开显示我的粉丝列表"
            initialHidden={flags.followerListHidden}
            hint="关闭后其他玩家无法查看你的粉丝"
          />
          <PrivacyToggle
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
          placeholder={"每行一个用户 ID，例如：\n3\n1234"}
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
