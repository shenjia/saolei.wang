"use client";

// 赞助登记表单（2026-10-30 后台赞助管理）
// 上半区：玩家 ID（可选，输 ID 自动识别玩家并回显在输入框下方）+ 金额（元）+ 提交。
// 不输 ID = 匿名赞助（user=0）。提交走统一 /api/admin/action（donate.add）。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

interface LookupUser {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  banned: boolean;
  title: string;
}

export function DonateForm() {
  const router = useRouter();
  // 登记日期（2026-10-30 张老师）：默认今天，可回填历史到账；sv-SE locale 输出 YYYY-MM-DD
  const today = new Date().toLocaleDateString("sv-SE");
  const [idText, setIdText] = useState("");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [lookup, setLookup] = useState<{ loading: boolean; user: LookupUser | null; notFound: boolean }>({
    loading: false,
    user: null,
    notFound: false,
  });
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ID 输入防抖识别（400ms）；清空立即复位为匿名态
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = idText.trim();
    if (!trimmed) {
      setLookup({ loading: false, user: null, notFound: false });
      return;
    }
    setLookup((s) => ({ ...s, loading: true }));
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/user-lookup?id=${encodeURIComponent(trimmed)}`);
        const data = (await res.json()) as { ok: boolean; found?: boolean; user?: LookupUser };
        setLookup({ loading: false, user: data.found ? data.user ?? null : null, notFound: !data.found });
      } catch {
        setLookup({ loading: false, user: null, notFound: false });
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [idText]);

  const canSubmit =
    !busy &&
    !!amount.trim() &&
    !lookup.loading &&
    (!idText.trim() || (!!lookup.user && !lookup.notFound));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "donate.add", id: idText.trim(), date, amount: amount.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      toast(data.ok ? data.message ?? "已登记" : data.error ?? "登记失败", data.ok ? "success" : "error");
      if (data.ok) {
        // 日期保留不重置（2026-10-30 张老师）：方便连续录入同一日的多笔账单
        setIdText("");
        setAmount("");
        setLookup({ loading: false, user: null, notFound: false });
        router.refresh();
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="donate_form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <label>
        玩家 ID
        <input
          className="admin_input"
          type="text"
          inputMode="numeric"
          placeholder="留空 = 匿名赞助"
          value={idText}
          onChange={(e) => setIdText(e.target.value.replace(/[^\d]/g, ""))}
          style={{ width: 140 }}
        />
      </label>
      <label>
        日期
        <input
          className="admin_input"
          type="date"
          max={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ width: 150 }}
        />
      </label>
      <label>
        金额（元）
        <input
          className="admin_input"
          type="text"
          inputMode="decimal"
          placeholder="如 100 或 27.7"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ width: 140 }}
        />
      </label>
      <button type="submit" className="admin_btn primary" disabled={!canSubmit}>
        {busy ? "提交中…" : "登记赞助"}
      </button>

      {/* 识别结果回显（输入框下方） */}
      <div className="donate_lookup">
        {lookup.loading && <span className="sub">识别中…</span>}
        {!lookup.loading && lookup.notFound && (
          <span className="admin_tag bad">#{idText.trim()} 不存在，请核对（或留空按匿名登记）</span>
        )}
        {!lookup.loading && lookup.user && (
          <span>
            <span className="admin_tag ok">#{lookup.user.id}</span>{" "}
            <b style={{ color: "#f8f8f2" }}>{lookup.user.chineseName}</b>
            {lookup.user.englishName ? <span className="sub"> {lookup.user.englishName}</span> : null}{" "}
            <span style={{ color: "#a6e22e" }}>{lookup.user.title}</span>
            {lookup.user.banned ? <span className="admin_tag warn"> 已封禁</span> : null}
          </span>
        )}
        {!lookup.loading && !lookup.user && !lookup.notFound && idText.trim() === "" && (
          <span className="sub">未填写 ID，将按匿名赞助登记</span>
        )}
      </div>
    </form>
  );
}
