"use client";
// 开源扫雷网绑定流程交互件（2026-11-09 绑定协议 v2：跳转确认+回来核销）
// OpenmsBindStart   —— 发起模式：勾开关生成申请 → 新标签页打开开源扫雷网授权页，
//                      本页留在原地显示等待动画并每 5 秒轮询核销（2026-11-10 张老师定）
// OpenmsBindConfirm —— 确认模式：开源扫雷网发起的申请（?token= 跳进来），核验信息展示+确认
// OpenmsBindPrefs   —— 已绑定用户的同步开关
//
// 开关口径（2026-11-09 张老师定）：本页唯一开关「开源扫雷网录像自动同步到扫雷网」，
// 默认勾选；「扫雷网→开源扫雷网」的开关在开源扫雷网授权页，各站管各站方向的同步。
import { useEffect, useState } from "react";
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

async function postBind(body: Record<string, unknown>): Promise<{
  ok?: boolean;
  error?: string;
  profile?: number;
  token?: string;
  authUrl?: string;
}> {
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
 * 文字随开关态变色：开=亮灰，关=暗灰（2026-11-09 张老师要求）。
 * inline=true（2026-11-10 张老师：账户设置页挪进「开源扫雷网」行内）：
 * 容器改 inline-flex 紧跟「已绑定」标签，压过 legacy .form td div{float:left} 换行浮动。 */
function SyncToggle({
  consent,
  onChange,
  label,
  hint,
  inline,
}: {
  consent: boolean;
  onChange: (v: boolean) => void;
  /** 开关右侧文字（账户设置页复用时传短文案「从开源扫雷网同步录像」） */
  label: string;
  /** 开关下方提示语（可选；确认模式=可在账户设置调整，发起/偏好=开源扫雷网授权页可设反方向；
   * 账户设置页传空串不渲染） */
  hint?: string;
  /** 行内形态：开关容器 inline-flex + 左间距，与「已绑定」标签同排 */
  inline?: boolean;
}) {
  return (
    <div
      style={
        inline
          ? { display: "inline-flex", alignItems: "center", margin: "0 0 0 14px", verticalAlign: "middle" }
          : { margin: "14px 0" }
      }
    >
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
  /** 等待态：授权页已在新标签页打开，本页按 5 秒间隔轮询核销。
   * needManual = 新标签页被浏览器拦截时，给用户一个可点的授权页链接兜底 */
  const [waiting, setWaiting] = useState<{ token: string; authUrl: string; needManual: boolean } | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const { token } = waiting;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 核销成功：气泡提示「绑定成功」，随后回账户管理页。
     * ToastHost 挂在根 layout，软导航不卸载，气泡会照常停留一拍 */
    function succeed() {
      toast("绑定成功", "success");
      setWaiting(null);
      setBusy(false);
      router.push("/account");
    }

    async function tick() {
      if (cancelled) return;
      // settle = 雷网拿 token 反查开源站 status，confirmed 才落 openms_link
      const res = await postBind({ action: "settle", token });
      if (cancelled) return;
      if (res.ok) {
        succeed();
        return;
      }
      if (res.error === "not_pending") {
        // 申请已被处理：可能被别处核销，也可能被新发起的申请顶掉（status=2），
        // 不能一律报成功。刷新页面交给服务端状态决定显示「已绑定」还是「重新发起」
        setWaiting(null);
        setBusy(false);
        router.refresh();
        return;
      }
      if (res.error === "not_found" || res.error === "profile_taken") {
        toast(ERR_TEXT[res.error] ?? "绑定未完成，请重新发起", "error");
        setWaiting(null);
        setBusy(false);
        return;
      }
      // openms_not_confirmed（尚未确认）/ openms_api（开源站暂时不可达）：继续等
      timer = setTimeout(tick, 5000);
    }

    void tick(); // 立即查一次，之后每 5 秒一次
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [waiting, router]);

  /** 发起绑定：先在用户手势的同步栈里开空白新标签页（await 之后再 window.open 会被弹窗拦截），
   *  create 返回后把授权页地址写进该标签页；本页不跳转，显示等待动画并轮询。 */
  async function create() {
    if (busy) return;
    setBusy(true);
    const win = window.open("", "_blank");
    const res = await postBind({ action: "create", consent });
    if (res.ok && res.token && res.authUrl) {
      if (win) {
        win.opener = null;
        win.location.href = res.authUrl;
      }
      setWaiting({ token: res.token, authUrl: res.authUrl, needManual: !win });
      return; // 轮询中保持 busy，等待态不再渲染发起按钮
    }
    if (win) win.close();
    toast(ERR_TEXT[res.error ?? ""] ?? "创建失败，请稍后重试", "error");
    setBusy(false);
  }

  if (waiting) {
    return (
      <div style={{ textAlign: "center", padding: "18px 0" }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 16,
            height: 16,
            marginRight: 9,
            verticalAlign: "middle",
            border: "2px solid rgba(166, 226, 46, 0.28)",
            borderTopColor: "#a6e22e",
            borderRadius: "50%",
            animation: "toast_spin 0.72s linear infinite",
          }}
        />
        <span style={{ verticalAlign: "middle" }}>等待开源扫雷网确认授权...</span>
        {waiting.needManual ? (
          <p style={{ marginTop: 10, fontSize: 13 }}>
            <a href={waiting.authUrl} target="_blank" rel="noreferrer">
              打开开源扫雷网授权页
            </a>
          </p>
        ) : null}
      </div>
    );
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
        {busy ? "提交中…" : "发起绑定"}
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
  inline,
}: {
  initialConsent: boolean;
  /** 自定义开关文字/提示（默认授权页口径；账户设置页复用时传「自动同步录像到扫雷网」） */
  label?: string;
  hint?: string;
  /** 行内形态（2026-11-10）：容器 inline-flex，与「已绑定」标签同排（透传 SyncToggle） */
  inline?: boolean;
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
      inline={inline}
    />
  );
}
