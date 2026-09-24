// 后台动作组件（2026-09-24）
// 所有写操作都打同一个接口 POST /api/admin/action（{ op, ...params }），
// 由服务端按 op 做权限校验 + 参数白名单，前端只负责交互与反馈。
//
// 组件层次：
//   postOp()       —— 裸调用（供自定义交互复用）
//   AdminAction    —— 按钮（可带二次确认）
//   AdminSelect    —— 下拉即生效（改角色 / 改状态）
//   AdminForm      —— 多字段表单（重置密码 / 群发广播 / 指定一星）

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { toast } from "@/components/Toast";

export interface OpResponse {
  ok: boolean;
  message?: string;
  error?: string;
}

/** 调用后台写操作接口 */
export async function postOp(op: string, params: Record<string, unknown> = {}): Promise<OpResponse> {
  try {
    const res = await fetch("/api/admin/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...params }),
    });
    const data = (await res.json()) as OpResponse;
    if (!res.ok && !data.error) return { ok: false, error: `请求失败（${res.status}）` };
    return data;
  } catch {
    return { ok: false, error: "网络错误，请重试" };
  }
}

/** 统一「执行 → 提示 → 刷新」流程 */
export function useOp() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (op: string, params: Record<string, unknown> = {}): Promise<boolean> => {
      setBusy(true);
      const res = await postOp(op, params);
      setBusy(false);
      toast(res.ok ? res.message ?? "操作成功" : res.error ?? "操作失败");
      if (res.ok) startTransition(() => router.refresh());
      return res.ok;
    },
    [router]
  );

  return { run, busy: busy || pending };
}

// ---------- 按钮 ----------

export function AdminAction({
  op,
  params,
  label,
  confirm,
  variant,
  sm = true,
  disabled,
  onDone,
}: {
  op: string;
  params?: Record<string, unknown>;
  label: string;
  /** 二次确认文案（不给则直接执行） */
  confirm?: string;
  variant?: "primary" | "danger" | "warn";
  sm?: boolean;
  disabled?: boolean;
  onDone?: (ok: boolean) => void;
}) {
  const { run, busy } = useOp();
  return (
    <button
      type="button"
      className={`admin_btn${variant ? " " + variant : ""}${sm ? " sm" : ""}`}
      disabled={disabled || busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        const ok = await run(op, params);
        onDone?.(ok);
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

// ---------- 下拉即生效 ----------

export function AdminSelect({
  op,
  params,
  name,
  value,
  options,
  confirm,
  title,
}: {
  op: string;
  params?: Record<string, unknown>;
  name: string;
  value: string;
  options: [string, string][];
  confirm?: string;
  title?: string;
}) {
  const { run, busy } = useOp();
  return (
    <select
      className="admin_select"
      title={title}
      value={value}
      disabled={busy}
      onChange={async (e) => {
        const next = e.target.value;
        if (confirm && !window.confirm(confirm)) {
          e.target.value = value;
          return;
        }
        await run(op, { ...params, [name]: next });
      }}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

// ---------- 表单 ----------

export interface FormField {
  name: string;
  label: string;
  type?: "text" | "password" | "textarea" | "select" | "date" | "number";
  placeholder?: string;
  options?: [string, string][];
  defaultValue?: string;
  hint?: string;
  required?: boolean;
  width?: string;
}

export function AdminForm({
  op,
  params,
  fields,
  submitLabel,
  confirm,
  layout = "row",
  resetAfterSubmit = true,
  children,
}: {
  op: string;
  params?: Record<string, unknown>;
  fields: FormField[];
  submitLabel: string;
  confirm?: string;
  /** row = 单行工具条（筛选用），stack = 竖向表单 */
  layout?: "row" | "stack";
  resetAfterSubmit?: boolean;
  children?: React.ReactNode;
}) {
  const { run, busy } = useOp();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""]))
  );

  return (
    <form
      className={layout === "row" ? "admin_field" : undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        for (const f of fields) {
          if (f.required && !values[f.name]?.trim()) {
            toast(`请填写「${f.label}」`);
            return;
          }
        }
        if (confirm && !window.confirm(confirm)) return;
        const ok = await run(op, { ...params, ...values });
        if (ok && resetAfterSubmit) {
          setValues(Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])));
        }
      }}
      style={layout === "stack" ? { display: "flex", flexDirection: "column", gap: 10 } : undefined}
    >
      {fields.map((f) => (
        <label
          key={f.name}
          style={
            layout === "stack"
              ? { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#939387" }
              : { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#75715e" }
          }
        >
          {f.label}
          {f.type === "textarea" ? (
            <textarea
              className="admin_textarea"
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          ) : f.type === "select" ? (
            <select
              className="admin_select"
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            >
              {(f.options ?? []).map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`admin_input${f.width ? " " + f.width : ""}`}
              type={f.type ?? "text"}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          )}
          {f.hint && <span className="admin_hint">{f.hint}</span>}
        </label>
      ))}
      {children}
      <button type="submit" className="admin_btn primary" disabled={busy}>
        {busy ? "处理中…" : submitLabel}
      </button>
    </form>
  );
}
