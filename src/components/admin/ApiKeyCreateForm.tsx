"use client";

// 签发 API key 表单（2026-10-24）：提交成功后不走 toast 回显明文——
// 弹 ApiKeyDialog 模态展示 key（明文唯一一次显示，确认保存后才能关闭）。
// 服务端 op 返回 message 形如「已为「xx」签发 API key（#3）：sk-… —— 请立即复制保存…」，
// 这里从 message 里剥出 sk-… 明文给弹窗；剥不出来（服务端格式变更）时降级弹 message 全文。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { ApiKeyDialog } from "./ApiKeyDialog";

export function ApiKeyCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const res = await postOp("apikey.create", { name: name.trim(), note: note.trim() });
    setBusy(false);
    if (!res.ok) {
      setIssued({ name: name.trim(), key: res.error ?? "操作失败" });
      return;
    }
    // message 里剥 sk- 明文；匹配不到就把整条 message 放弹窗里展示（不丢信息）
    const m = res.message ?? "";
    const match = m.match(/sk-[A-Za-z0-9_-]+/);
    setIssued({ name: name.trim(), key: match ? match[0] : m });
    router.refresh();
  };

  return (
    <>
      <form className="admin_field" action="" onSubmit={submit}>
        <label>
          合作方名称
          <input
            className="admin_input"
            placeholder="如 openms.top"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          备注
          <input
            className="admin_input wide"
            placeholder="用途 / 联系方式（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="submit" className="admin_btn primary" disabled={busy}>
          {busy ? "签发中…" : "签发"}
        </button>
      </form>
      <p className="admin_hint" style={{ marginTop: 8 }}>
        明文 key 将在弹窗中显示，请当场复制发给合作方；库里只存哈希，关闭弹窗后不可再查。
      </p>
      {issued && <ApiKeyDialog name={issued.name} keyText={issued.key} onClose={() => setIssued(null)} />}
    </>
  );
}
