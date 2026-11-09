// 账号中心 · 开源扫雷网绑定（2026-11-09 绑定协议 v2：跳转确认+回来核销）
// 双模式：
//   ?token=<令牌> → 确认模式（开源站发起的申请跳进来，核验后落绑定）
//   无参数        → 发起模式（生成申请 → 跳开源站授权页 → 回来核销）
// 已绑定用户展示绑定状态与两个同步开关（默认关闭，2026-11-08「默认不同意」口径）。
// 协议契约：docs/partner-api-openms.md

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getOpenmsLink, verifyOpenmsRequest, OpenmsBindError } from "@/lib/openms";
import { OpenmsBindStart, OpenmsBindConfirm, OpenmsBindPrefs } from "@/components/OpenmsBind";
import { UserPanel } from "@/components/UserCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "绑定开源扫雷网" };

const TOKEN_RE = /^[0-9a-f]{48}$/;

const CONSENT_TEXT = ["未表态（默认不同意）", "已同意同步", "已拒绝同步"] as const;

export default async function OpenmsBindPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const sp = await searchParams;
  const token = sp.token ?? "";
  const link = await getOpenmsLink(session.uid);

  // 确认模式：核验开源站发起的申请（服务端直调开源站 API）
  let confirmInfo: { profile: number; username: string } | null = null;
  let confirmError = "";
  if (TOKEN_RE.test(token)) {
    try {
      confirmInfo = await verifyOpenmsRequest(token);
    } catch (e) {
      confirmError =
        e instanceof OpenmsBindError && e.code === "openms_not_confirmed"
          ? "该申请已被处理或失效"
          : "开源站接口暂时无法访问，请稍后重试";
    }
  } else if (token) {
    confirmError = "绑定令牌格式不正确";
  }

  return (
    <div id="page" className="two_columns">
      <ul id="account_openms_bind">
        <li className="main">
          <div className="box">
            <div className="nav">
              <h1>绑定开源扫雷网</h1>
              <ul className="email_back">
                <li>
                  <Link href="/account">返回</Link>
                </li>
              </ul>
            </div>
            <hr />

            {link ? (
              <div>
                <p>
                  当前绑定状态：<b>已绑定开源站账户 #{link.profile}</b>
                  <br />
                  <span style={{ fontSize: 13, color: "#b1b1a4" }}>
                    历史录像同步表态：{CONSENT_TEXT[link.consent]}
                  </span>
                </p>
                <p style={{ fontSize: 13, color: "#b1b1a4" }}>
                  同步开关控制两个方向：开源网 → 扫雷网由本站执行导入，扫雷网 → 开源网由本站接口按开关放行。
                </p>
                <OpenmsBindPrefs
                  initialConsent={link.consent === 1}
                  initialSyncToOpenms={link.syncToOpenms === 1}
                />
              </div>
            ) : confirmInfo ? (
              <OpenmsBindConfirm
                token={token}
                profile={confirmInfo.profile}
                username={confirmInfo.username}
              />
            ) : confirmError ? (
              <p className="error">{confirmError}</p>
            ) : (
              <OpenmsBindStart />
            )}
          </div>
        </li>
        <li className="sidebar">
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
