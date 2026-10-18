"use client";

// 称号体系偏好卡（Phase 5，/titles 右栏「旧版称号」下方）
// 2026-10-18 张老师定：未登录也可切换（localStorage 本设备生效）；
// 登录玩家切换时写 user_info.title_pref（跨设备）+ localStorage（本设备即时生效）。
// 切换即时重渲染（context setLocalTitleSystem），无需整页刷新。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTitleSystem, setLocalTitleSystem } from "./TitleSystemProvider";
import type { TitleSystem } from "@/lib/title-system";

export function TitlePrefSwitch({ loggedIn }: { loggedIn: boolean }) {
  const router = useRouter();
  const { system } = useTitleSystem(); // 含 localStorage 覆盖后的最终值
  const [saving, setSaving] = useState(false);

  const pick = async (key: TitleSystem) => {
    if (saving) return;
    setSaving(true);
    setLocalTitleSystem(key); // 本设备即时生效（context 立即重渲染）
    if (loggedIn) {
      try {
        await fetch("/api/account/title-pref", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: key }),
        });
      } catch {
        /* 库写失败不影响本设备体验 */
      }
    }
    // 刷新服务端组件树（layout Provider 的服务端值与本设备一致化）
    router.refresh();
    setSaving(false);
  };

  const isC = system === "c";

  return (
    <div className="box title_pref_box">
      <h2>我的偏好</h2>
      <div className="title_pref_opts">
        <button
          type="button"
          className={`title_pref_opt ${!isC ? "on" : ""}`}
          onClick={() => isC && pick("m")}
          disabled={saving}
        >
          <span className="name">军衔体系（2026版）</span>
          <span className="desc">总司令 · 大元帅 · … · 列兵</span>
        </button>
        <button
          type="button"
          className={`title_pref_opt ${isC ? "on" : ""}`}
          onClick={() => !isC && pick("c")}
          disabled={saving}
        >
          <span className="name">人神界体系（2008版）</span>
          <span className="desc">雷帝 · 雷圣 · … · 童生</span>
        </button>
      </div>
      <div className="title_pref_note">
        {loggedIn
          ? "全站称号按你选择的体系显示（账号内跨设备生效）。"
          : "全站称号按你选择的体系显示（保存在本设备；登录后可跨设备）。"}
      </div>
    </div>
  );
}
