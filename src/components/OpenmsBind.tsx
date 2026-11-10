"use client";
// 开源扫雷网绑定流程交互件（2026-11-09 绑定协议 v2：跳转确认+回来核销）
// OpenmsBindStart   —— 发起模式：勾开关生成申请 → 当前页直接跳开源扫雷网授权页（2026-11-10 张老师定）
// OpenmsBindConfirm —— 确认模式：开源扫雷网发起的申请（?token= 跳进来），核验信息展示+确认
// OpenmsBindPrefs   —— 已绑定用户的同步开关
//
// 开关口径（2026-11-09 张老师定）：本页唯一开关「开源扫雷网录像自动同步到扫雷网」，
// 默认勾选；「扫雷网→开源扫雷网」的开关在开源扫雷网授权页，各站管各站方向的同步。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

/** 绑定协议错误码 → 友好文案 */
const ERR_TEXT: Record<string, string> = {
  not_found: "绑定申请不存在或已失效，请重新发起",
  not_pending: "该申请已处理，请勿重复核销",
  openms_api: "开源扫雷网接口暂时无法访问，请稍后重试",
  openms_not_confirmed: "尚未在开源扫雷网完成确认，请先去开源扫雷网授权页点「确认绑定」",
  profile_taken: "该开源扫雷网账户已被其他雷网账户绑定",
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

/** 同步开关（三处复用；本页唯一开关＝开源扫雷网→扫雷网方向）。
 * 滑块样式复用账户设置页 acct_gsw（样式块见 globals.css #account_openms_bind 段）；
 * 文字随开关态变色：开=亮灰，关=暗灰（2026-11-09 张老师要求）。 */
function SyncToggle({
  consent,
  onChange,
  label,
  hint,
}: {
  consent: boolean;
  onChange: (v: boolean) => void;
  /** 开关右侧文字（账户设置页复用时传短文案「从开源扫雷网同步录像」） */
  label: string;
  /** 开关下方提示语（可选；确认模式=可在账户设置调整，发起/偏好=开源扫雷网授权页可设反方向；
   * 账户设置页传空串不渲染） */
  hint?: string;
}) {
  return (
    <div style={{ margin: "14px 0" }}>
      <label className="acct_gsw">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="track" />
        <span className="txt">{label}</span>
      </label>
      {hint ? (
        <p className="hint" style={{ marginTop: 6, fontSize: 13, color: "#b1b1a4" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function OpenmsBindStart({
  saoleiUid,
  saoleiName,
}: {
  /** 本站账户名与 uid（主文案「本账户（xxx #uid）」展示用） */
  saoleiUid: number;
  saoleiName: string;
}) {
  const router = useRouter();
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);

  /** 发起绑定：生成申请后当前页直接跳转开源扫雷网授权页（2026-11-10 张老师要求，
   * 不再展示中间确认页；核销回来走页面上的「我已在开源扫雷网确认」按钮或 ?token= 确认模式） */
  async function create() {
    if (busy) return;
    setBusy(true);
    const res = await postBind({ action: "create", consent });
    if (res.ok && res.authUrl) {
      toast("申请已创建，正在跳转开源扫雷网授权页…", "success");
      window.location.href = res.authUrl;
      return; // 跳转中保持 busy，防重复提交
    }
    toast(ERR_TEXT[res.error ?? ""] ?? "创建失败，请稍后重试", "error");
    setBusy(false);
  }

  return (
    <div style={{ textAlign: "center" }}>
      <p>
        你正在申请将本账户（<b>{saoleiName}</b> #{saoleiUid}）与开源扫雷网进行绑定
      </p>
      <SyncToggle
        consent={consent}
        onChange={setConsent}
        label="开源扫雷网录像自动同步到扫雷网（包括历史录像和今后上传录像）"
        hint="如要将扫雷网的录像同步到开源扫雷网，可在开源扫雷网的授权确认页操作"
      />
      <button type="button" className="button active" disabled={busy} onClick={create}>
        {busy ? "跳转中…" : "发起绑定"}
      </button>
    </div>
  );
}

export function OpenmsBindConfirm({
  token,
  profile,
  username,
  saoleiUid,
  saoleiName,
}: {
  token: string;
  profile: number;
  username: string;
  /** 本站账户名与 uid（文案「绑定到扫雷网账户 xxx（#uid）」展示用） */
  saoleiUid: number;
  saoleiName: string;
}) {
  const router = useRouter();
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const res = await postBind({ action: "confirm", token, consent });
    if (res.ok) {
      toast("绑定完成", "success");
      router.refresh();
      return;
    }
    toast(ERR_TEXT[res.error ?? ""] ?? "确认失败，请稍后重试", "error");
    setBusy(false);
  }

  return (
    <div style={{ textAlign: "center" }}>
      <p>
        正在将开源扫雷网账户 <b>{username}</b>（#{profile}）绑定到扫雷网账户{" "}
        <b>{saoleiName}</b>（#{saoleiUid}）
      </p>
      <SyncToggle
        consent={consent}
        onChange={setConsent}
        label="开源扫雷网录像自动同步到扫雷网（包括历史录像和今后上传录像）"
        hint="绑定完成后，你可以在账户设置中随时调整此开关"
      />
      <button type="button" className="button active" disabled={busy} onClick={confirm}>
        {busy ? "提交中…" : "确认绑定"}
      </button>
    </div>
  );
}

export function OpenmsBindPrefs({
  initialConsent,
  label,
  hint,
}: {
  initialConsent: boolean;
  /** 自定义开关文字/提示（默认授权页口径；账户设置页复用时传「从开源扫雷网同步录像」） */
  label?: string;
  hint?: string;
}) {
  const [consent, setConsent] = useState(initialConsent);
  const [busy, setBusy] = useState(false);

  async function save(v: boolean) {
    const prev = consent;
    setConsent(v);
    setBusy(true);
    const res = await postBind({ action: "update", consent: v });
    if (res.ok) {
      toast("同步偏好已保存", "success");
    } else {
      toast(ERR_TEXT[res.error ?? ""] ?? "保存失败，请稍后重试", "error");
      setConsent(prev);
    }
    setBusy(false);
  }

  return (
    <SyncToggle
      consent={consent}
      onChange={save}
      label={label ?? "开源扫雷网录像自动同步到扫雷网（包括历史录像和今后上传录像）"}
      hint={hint ?? "开源扫雷网的授权确认页，可以设置是否将扫雷网的录像同步到开源扫雷网"}
    />
  );
}
