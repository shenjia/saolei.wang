// 账号中心 · 开源扫雷网绑定（2026-11-09 绑定协议 v2：跳转确认+回来核销）
// 双模式：
//   ?token=<令牌> → 确认模式（开源扫雷网发起的申请跳进来，核验后落绑定）
//   无参数        → 发起模式（生成申请 → 跳开源扫雷网授权页 → 回来核销）
// 已绑定用户展示绑定状态与同步开关（唯一开关「开源扫雷网→扫雷网」，默认勾选，2026-11-09 张老师定；
// 「扫雷网→开源扫雷网」的开关在开源扫雷网授权页）。
// 协议契约：docs/partner-api-openms.md

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getOpenmsLink, verifyOpenmsRequest, OpenmsBindError } from "@/lib/openms";
import { OpenmsBindStart, OpenmsBindConfirm, OpenmsBindPrefs } from "@/components/OpenmsBind";
import { UserPanel } from "@/components/UserCard";

export const dynamic = "force-dynamic";

const TOKEN_RE = /^[0-9a-f]{48}$/;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  return {
    title: TOKEN_RE.test(sp.token ?? "")
      ? "来自开源扫雷网的绑定请求"
      : "对开源扫雷网发起绑定请求",
  };
}

const CONSENT_TEXT = ["未表态（默认不同意）", "已同意同步", "已拒绝同步"] as const;

/** 绑定示意图（2026-11-09 张老师要求）：分割线下方两站点卡 + 中间箭头。
 * 发起模式：左扫雷网 → 右开源扫雷网；确认模式（开源扫雷网发起）对调：左开源扫雷网 → 右扫雷网，
 * 箭头均由左指向右（2026-11-09 张老师定：确认页卡片对调、箭头反向）。 */
function BindDiagram({ isConfirmMode }: { isConfirmMode: boolean }) {
  const sideSaolei = (
    <div className="side">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="扫雷网" width={48} height={48} />
      <div className="name">扫雷网</div>
      <div className="domain">saolei.wang</div>
    </div>
  );
  const sideOpenms = (
    <div className="side">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/openms-logo.svg" alt="开源扫雷网" width={48} height={48} />
      <div className="name">开源扫雷网</div>
      <div className="domain">openms.top</div>
    </div>
  );
  return (
    <div className="bind_diagram">
      {isConfirmMode ? sideOpenms : sideSaolei}
      <div className="arrow">⟶</div>
      {isConfirmMode ? sideSaolei : sideOpenms}
    </div>
  );
}

export default async function OpenmsBindPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const sp = await searchParams;
  const token = sp.token ?? "";
  const isConfirmMode = TOKEN_RE.test(token);
  const link = await getOpenmsLink(session.uid);

  // 本站账户名（老账号无 user_auth 行回退中文名，与公开 API 口径一致；两模式文案共用）
  const [auth, urow] = await Promise.all([
    prisma.userAuth.findUnique({ where: { id: session.uid }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: session.uid }, select: { chineseName: true } }),
  ]);
  const saoleiName = auth?.username ?? urow?.chineseName ?? "";

  // 确认模式：核验开源扫雷网发起的申请（服务端直调开源扫雷网 API）
  let confirmInfo: { profile: number; username: string } | null = null;
  let confirmError = "";
  if (isConfirmMode) {
    try {
      confirmInfo = await verifyOpenmsRequest(token);
    } catch (e) {
      confirmError =
        e instanceof OpenmsBindError && e.code === "openms_not_confirmed"
          ? "该申请已被处理或失效"
          : "开源扫雷网接口暂时无法访问，请稍后重试";
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
              <h1>{isConfirmMode ? "来自开源扫雷网的绑定请求" : "对开源扫雷网发起绑定请求"}</h1>
              <ul className="email_back">
                <li>
                  <Link href="/account">返回</Link>
                </li>
              </ul>
            </div>
            <hr />

            <BindDiagram isConfirmMode={isConfirmMode} />

            {link ? (
              <div>
                <p>
                  当前绑定状态：<b>已绑定开源扫雷网账户 #{link.profile}</b>
                  <br />
                  <span style={{ fontSize: 13, color: "#b1b1a4" }}>
                    历史录像同步表态：{CONSENT_TEXT[link.consent]}
                  </span>
                </p>
                <p style={{ fontSize: 13, color: "#b1b1a4" }}>
                  「开源扫雷网 → 扫雷网」的同步由本站按下方开关执行；「扫雷网 → 开源扫雷网」的开关在开源扫雷网授权页设置。
                </p>
                <OpenmsBindPrefs initialConsent={link.consent === 1} />
              </div>
            ) : confirmInfo ? (
              <OpenmsBindConfirm
                token={token}
                profile={confirmInfo.profile}
                username={confirmInfo.username}
                saoleiUid={session.uid}
                saoleiName={saoleiName}
              />
            ) : confirmError ? (
              <p className="error">{confirmError}</p>
            ) : (
              <OpenmsBindStart saoleiUid={session.uid} saoleiName={saoleiName} />
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
