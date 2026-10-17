"use client";

// 称号体系切换卡（2026-10-17 Phase 5）：/titles 页顶部
// 未登录：两套体系静态展示 + 登录提示（点击跳登录）；
// 已登录：点选持久化 user_info.title_pref，全站渲染跟随切换（刷新生效）。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TITLE_SYSTEMS, type TitleSystem } from "@/lib/title-system";

export function TitlePrefSwitch({
  current,
  loggedIn,
}: {
  current: TitleSystem;
  loggedIn: boolean;
}) {
  const router = useRouter();
  const [sel, setSel] = useState<TitleSystem>(current);
  const [saving, setSaving] = useState(false);

  const pick = async (key: TitleSystem) => {
    if (!loggedIn || saving) return;
    setSel(key);
    setSaving(true);
    try {
      const res = await fetch("/api/account/title-pref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: key }),
      });
      if (res.ok) {
        // 刷新整页让服务端渲染按新体系输出（layout context 重注入）
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="box title_pref_box">
      <h2>称号体系</h2>
      <div className="title_pref_opts">
        {TITLE_SYSTEMS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`title_pref_opt ${sel === s.key ? "on" : ""}`}
            onClick={() => pick(s.key)}
            disabled={!loggedIn || saving}
            title={loggedIn ? `切换为${s.name}` : "登录后可切换"}
          >
            <span className="name">{s.name}</span>
            <span className="desc">{s.desc}</span>
          </button>
        ))}
      </div>
      <div className="title_pref_note">
        {loggedIn
          ? "切换后全站称号按你选择的体系显示（刷新页面生效）。"
          : "登录后可选择称号体系，全站称号将按你选择的体系显示。"}
      </div>
    </div>
  );
}
