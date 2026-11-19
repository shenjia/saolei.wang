"use client";

// 赞助登记表单（2026-10-30 后台赞助管理）
// 上半区：玩家 ID（可选，输 ID 自动识别玩家并回显在输入框下方）+ 金额（元）+ 提交。
// 不输 ID = 匿名赞助（user=0）。提交走统一 /api/admin/action（donate.add）。
// 编辑模式（2026-10-30 张老师）：清单行「编辑」按钮派发 sl-donate-edit 事件回填，
// 提交改走 donate.edit；取消恢复登记态。

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

/** 编辑模式状态（清单行回填用） */
interface EditingDonate {
  id: number;
  /** 原赞助者 uid（0=匿名） */
  user: number;
  /** 原金额（分） */
  amount: number;
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
  // 编辑模式（null=登记态）；回填由清单行的 sl-donate-edit 事件触发
  const [editing, setEditing] = useState<EditingDonate | null>(null);

  // 监听清单行「编辑」：回填记录（日期按东八区 Y-m-d、金额分→元字符串）
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: number; user: number; amount: number; createTime: number };
      if (!d || typeof d.id !== "number") return;
      setEditing({ id: d.id, user: d.user, amount: d.amount });
      setIdText(d.user > 0 ? String(d.user) : "");
      setDate(new Date((d.createTime + 8 * 3600) * 1000).toISOString().slice(0, 10));
      setAmount(String(d.amount / 100));
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("sl-donate-edit", onEdit);
    return () => window.removeEventListener("sl-donate-edit", onEdit);
  }, []);

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
        body: JSON.stringify(
          editing
            ? { op: "donate.edit", id: editing.id, idText: idText.trim(), date, amount: amount.trim() }
            : { op: "donate.add", id: idText.trim(), date, amount: amount.trim() }
        ),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      toast(data.ok ? data.message ?? "已登记" : data.error ?? "登记失败", data.ok ? "success" : "error");
      if (data.ok) {
        // 日期保留不重置（2026-10-30 张老师）：方便连续录入同一日的多笔账单；编辑完成退出编辑态
        setEditing(null);
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
      {/* 编辑模式提示条：显示正在改的记录，可取消回到登记态 */}
      {editing && (
        <div className="donate_lookup" style={{ color: "#e6b422" }}>
          正在编辑赞助记录 #{editing.id}（原 {editing.user > 0 ? `#${editing.user}` : "匿名"} ¥
          {(editing.amount / 100).toFixed(2)}；ID 留空 = 改为匿名）{" "}
          <button
            type="button"
            className="admin_btn sm"
            onClick={() => {
              setEditing(null);
              setIdText("");
              setAmount("");
              setLookup({ loading: false, user: null, notFound: false });
            }}
          >
            取消编辑
          </button>
        </div>
      )}

      {/* 日期放最左（2026-10-30 张老师） */}
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
        {busy ? "提交中…" : editing ? "保存修改" : "登记赞助"}
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
