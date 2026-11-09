"use client";
// 开源扫雷网绑定流程交互件（2026-11-09 绑定协议 v2：跳转确认+回来核销）
// OpenmsBindStart   —— 发起模式：勾两开关生成申请 → 跳开源站授权页 → 回来核销
// OpenmsBindConfirm —— 确认模式：开源站发起的申请（?token= 跳进来），核验信息展示+确认
// OpenmsBindPrefs   —— 已绑定用户的两个同步开关
//
// 开关口径：默认全部关闭（2026-11-08 张老师定「默认不同意」，与征求弹窗一致）。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

/** 绑定协议错误码 → 友好文案 */
const ERR_TEXT: Record<string, string> = {
  not_found: "绑定申请不存在或已失效，请重新发起",
  not_pending: "该申请已处理，请勿重复核销",
  openms_api: "开源站接口暂时无法访问，请稍后重试",
  openms_not_confirmed: "尚未在开源站完成确认，请先去开源站授权页点「确认绑定」",
  profile_taken: "该开源站账户已被其他雷网用户绑定",
  not_bound: "未找到绑定关系",
};

async function postBind(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; profile?: number; authUrl?: string }> {
  const r = await fetch("/api/openms/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await r.json();
  } catch {
    return { error: "openms_api" };
  }
}

/** 两个同步开关（三处复用） */
function SyncToggles({
  consent,
  syncToOpenms,
  onChange,
}: {
  consent: boolean;
  syncToOpenms: boolean;
  onChange: (v: { consent: boolean; syncToOpenms: boolean }) => void;
}) {
  return (
    <div style={{ margin: "14px 0", lineHeight: 2.2 }}>
      <label style={{ display: "block" }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => onChange({ consent: e.target.checked, syncToOpenms })}
        />{" "}
        开源网录像自动同步到扫雷网（本站导入您在开源网的历史与新录像）
      </label>
      <label style={{ display: "block" }}>
        <input
          type="checkbox"
          checked={syncToOpenms}
          onChange={(e) => onChange({ consent, syncToOpenms: e.target.checked })}
        />{" "}
        扫雷网录像自动同步到开源网
      </label>
      <p className="hint" style={{ marginTop: 6, fontSize: 13, color: "#b1b1a4" }}>
        两个开关默认关闭；不勾选即默认不同步，之后可随时回来调整。
      </p>
    </div>
  );
}

export function OpenmsBindStart() {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [syncToOpenms, setSyncToOpenms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ token: string; authUrl: string } | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    const res = await postBind({ action: "create", consent, syncToOpenms });
    if (res.ok && res.authUrl) {
      setPending({ token: res.authUrl.split("token=")[1] ?? "", authUrl: res.authUrl });
      toast("申请已创建，请到开源站授权页确认", "success");
    } else {
      toast(ERR_TEXT[res.error ?? ""] ?? "创建失败，请稍后重试", "error");
    }
    setBusy(false);
  }

  async function settle() {
    if (busy || !pending) return;
    setBusy(true);
    const res = await postBind({ action: "settle", token: pending.token });
    if (res.ok) {
      toast("绑定完成", "success");
      router.refresh();
      return;
    }
    toast(ERR_TEXT[res.error ?? ""] ?? "核销失败，请稍后重试", "error");
    setBusy(false);
  }

  if (pending) {
    return (
      <div>
        <p>
          申请已创建。请点击下方按钮前往开源站授权页，登录您的开源站账户并点「确认绑定」，
          然后回到本页点击「完成绑定」。
        </p>
        <p style={{ margin: "12px 0" }}>
          <a className="button active" href={pending.authUrl} target="_blank" rel="noreferrer">
            前往开源站授权页 ↗
          </a>
        </p>
        <p style={{ margin: "12px 0" }}>
          <button type="button" className="button active" disabled={busy} onClick={settle}>
            我已在开源站确认，完成绑定
          </button>
        </p>
        <p className="hint" style={{ fontSize: 13, color: "#b1b1a4" }}>
          申请 48 字符一次性令牌有效至核销或重新发起；开源站授权页会显示您的扫雷网账户名，请核对后再确认。
        </p>
      </div>
    );
  }

  return (
    <div>
      <p>
        绑定后，双方站点可在征得您同意的情况下同步您的扫雷录像。
        流程：在本页勾选同步开关 → 到开源站授权页登录确认 → 回到本页完成绑定。
      </p>
      <SyncToggles
        consent={consent}
        syncToOpenms={syncToOpenms}
        onChange={(v) => {
          setConsent(v.consent);
          setSyncToOpenms(v.syncToOpenms);
        }}
      />
      <button type="button" className="button active" disabled={busy} onClick={create}>
        {busy ? "提交中…" : "发起绑定"}
      </button>
    </div>
  );
}

export function OpenmsBindConfirm({
  token,
  profile,
  username,
}: {
  token: string;
  profile: number;
  username: string;
}) {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [syncToOpenms, setSyncToOpenms] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const res = await postBind({ action: "confirm", token, consent, syncToOpenms });
    if (res.ok) {
      toast("绑定完成", "success");
      router.refresh();
      return;
    }
    toast(ERR_TEXT[res.error ?? ""] ?? "确认失败，请稍后重试", "error");
    setBusy(false);
  }

  return (
    <div>
      <p>
        开源站用户 <b>{username}</b>（#{profile}）发起了与扫雷网账户的绑定申请。
        请确认后勾选同步开关，点「确认绑定」完成。
      </p>
      <SyncToggles
        consent={consent}
        syncToOpenms={syncToOpenms}
        onChange={(v) => {
          setConsent(v.consent);
          setSyncToOpenms(v.syncToOpenms);
        }}
      />
      <button type="button" className="button active" disabled={busy} onClick={confirm}>
        {busy ? "提交中…" : "确认绑定"}
      </button>
    </div>
  );
}

export function OpenmsBindPrefs({
  initialConsent,
  initialSyncToOpenms,
}: {
  initialConsent: boolean;
  initialSyncToOpenms: boolean;
}) {
  const [consent, setConsent] = useState(initialConsent);
  const [syncToOpenms, setSyncToOpenms] = useState(initialSyncToOpenms);
  const [busy, setBusy] = useState(false);

  async function save(v: { consent: boolean; syncToOpenms: boolean }) {
    setConsent(v.consent);
    setSyncToOpenms(v.syncToOpenms);
    setBusy(true);
    const res = await postBind({ action: "update", consent: v.consent, syncToOpenms: v.syncToOpenms });
    if (res.ok) {
      toast("同步偏好已保存", "success");
    } else {
      toast(ERR_TEXT[res.error ?? ""] ?? "保存失败，请稍后重试", "error");
      setConsent(initialConsent);
      setSyncToOpenms(initialSyncToOpenms);
    }
    setBusy(false);
  }

  return (
    <SyncToggles consent={consent} syncToOpenms={syncToOpenms} onChange={save} />
  );
}
