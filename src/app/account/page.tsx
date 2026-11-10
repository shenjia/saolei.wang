// 账户设置首页（2026-10-25 张老师：标题「账户管理」→「账户设置」，与导航菜单文案统一）
// 主栏：标题行（左「账户设置」h1 + 右「修改资料/修改密码」小按钮同行）→
//   头像单独一行（可点更换）→ 一张连续资料表（账户名/中文名/英文名与
//   地区、爱好、QQ 等同格式分栏，无小标题无分割线）。
// 侧栏：标准 UserPanel 玩家卡片（与录像详情页/论坛主题页右栏同款）。
// （2026-10-16 张老师：侧栏原「数据统计」盒已去掉，只留玩家卡片。）

import { existsSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { SelfAvatar } from "@/components/SelfAvatar";
import { UserPanel } from "@/components/UserCard";
import { QqBindLink } from "@/components/QqLogin";
import { QqAvatarPrompt } from "@/components/QqAvatarPrompt";
import { AccountVisibilityToggle } from "@/components/AccountVisibilityToggle";
import { QQ_OAUTH_ENABLED, areaDisplay } from "@/lib/config";
import { ageOf, constellationText } from "@/lib/birth";
import { AVATAR_REVIEW_STATUS, resolveAvatarUrl } from "@/lib/avatar";
import { avatarUrlFor } from "@/lib/small-avatar";
import { getOpenmsLink } from "@/lib/openms";
import { OpenmsBindPrefs } from "@/components/OpenmsBind";
import { donateYuanPlain } from "@/lib/donate";

export const dynamic = "force-dynamic";
export const metadata = { title: "账户设置" };

/** 账户名是否为邮箱（2026-10-15 张老师：非邮箱时才显示「绑定邮箱」入口） */
function isEmail(s: string): boolean {
  return s.includes("@");
}

export default async function AccountManagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const sp = await searchParams;
  const uid = BigInt(session.uid);
  const [detail, auth, latestAvatar, me, qqBinding, openmsLink, donateAgg] = await Promise.all([
    getUserDetail(session.uid),
    // 账户名 + 邮箱绑定状态：绑定入口跟在账户名后面（2026-10-15）
    prisma.userAuth.findUnique({
      where: { id: uid },
      select: { username: true, email: true, emailVerified: true },
    }),
    // 有无待审头像（SelfAvatar 的 pending 气泡）
    prisma.avatarReview.findFirst({
      where: { user: uid },
      orderBy: { id: "desc" },
      select: { status: true },
    }),
    prisma.user.findUnique({ where: { id: uid }, select: { avatar: true } }),
    // QQ 第三方绑定状态：未绑定则在 QQ 行后显示「（绑定QQ）」入口（2026-10-25 张老师定）
    // avatar：绑定后「要不要换成 QQ 头像」浮窗的右侧预览图（2026-10-27）
    prisma.userOauth.findFirst({
      where: { userId: uid, provider: "qq" },
      select: { nickname: true, avatar: true },
    }),
    // 开源扫雷网绑定状态（2026-11-09 绑定协议 v2：QQ 行后加「开源扫雷网」行）
    getOpenmsLink(session.uid),
    // 本人赞助合计（2026-11-10 张老师：鼠标垫行后加「赞助金额」行，仅赞助过才显示；
    // 金额单位分，与个人主页数据统计口径一致）
    prisma.donate.aggregate({ where: { user: uid }, _sum: { amount: true } }),
  ]);
  if (!detail) redirect("/account/login");
  const { user, info } = detail;

  const rows: [string, string][] = [
    // 地区（2026-10-25 张老师要求加在爱好前）：存库中文原值，显示走 areaDisplay 合规化
    //（香港/澳门/台湾 → 中国香港/中国澳门/中国台湾；「海外」原样显示）
    ["地区", user.area ? areaDisplay(user.area) : ""],
    ["爱好", info?.interest ?? ""],
    ["QQ", info?.qq ?? ""],
    ["昵称", info?.nickname ?? ""],
    ["鼠标", info?.mouse ?? ""],
    ["鼠标垫", info?.pad ?? ""],
  ];

  const accountName = auth?.username ?? session.username ?? "";
  const needBindEmail = !!auth && !isEmail(accountName);
  // 年龄+星座（2026-11-03 张老师）：英文名后各占独立一行；未填生日不显示
  const age = ageOf(info?.birthday);
  const constellation = constellationText(info?.birthday);
  // 赞助金额（2026-11-10 张老师）：鼠标垫行后独立一行，仅赞助过（合计>0）才显示
  const donateCents = Number(donateAgg._sum.amount ?? 0);

  // 头像优先级与个人主页一致：新版上传 → OAuth 外链 → 本地照片墙 → 默认图
  const photo = resolveAvatarUrl(
    me?.avatar ?? "",
    existsSync(path.join(process.cwd(), "public", "images", "player", `${session.uid}.jpg`))
      ? `/images/player/${session.uid}.jpg`
      : "/images/common/avatar.png",
  );
  // 162px 展示位走 big 360px 档（2x retina，2026-11-10 全站头像 WebP 化）；
  // OAuth 外链 / 默认图无本地档位 → 回退原图（photo 本身）
  const photoBig = avatarUrlFor(me?.avatar ?? "", session.uid, "big") ?? photo;
  const avatarPending = latestAvatar?.status === AVATAR_REVIEW_STATUS.PENDING;

  return (
    <div id="page" className="two_columns">
      <ul id="account_manage">
        <li className="main">
          <div className="box">
            <div className="manage_head">
              <h1>账户设置</h1>
              <div className="manage_actions">
                <Link href="/account/profile" className="button small">
                  修改资料
                </Link>
                <Link href="/account/password" className="button small">
                  修改密码
                </Link>
              </div>
            </div>
            <hr />

            {/* 头像单独一列居左（可点更换），右侧一张连续资料表（账户名/中文名/英文名
                与爱好、QQ 等同格式分栏，无小标题无分割线，2026-10-15 五轮张老师定稿） */}
            <div className="account_identity">
              <div className="account_avatar_cell">
                <SelfAvatar src={photoBig} fallbackSrc={photo} alt={user.chineseName} pending={avatarPending} />
              </div>
              <table className="form" cellPadding={0} cellSpacing={0}>
                <tbody>
                  <tr>
                    <th>账户名</th>
                    <td>
                      <div>
                        {accountName}
                        {needBindEmail && (
                          <Link href="/account/email" className="bind_email_btn">
                            绑定邮箱
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th>中文名</th>
                    <td>
                      <div>{user.chineseName}</div>
                    </td>
                  </tr>
                  <tr>
                    <th>英文名</th>
                    <td>
                      <div>{user.englishName}</div>
                    </td>
                  </tr>
                  {/* 年龄 / 星座（2026-11-03 张老师二改）：各占独立一行；未填生日不显示。
                      行尾「在主页展示xx」开关（2026-11-10 张老师：原页面底部合并开关分拆为两个；
                      二改：文案分列 + 一律靠右对齐） */}
                  {age !== null && (
                    <tr>
                      <th>年龄</th>
                      <td>
                        <div className="acct_vis_cell">
                          {age}
                          <AccountVisibilityToggle
                            field="age"
                            label="年龄"
                            switchText="在主页展示年龄"
                            initialHidden={user.ageHidden}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  {constellation && (
                    <tr>
                      <th>星座</th>
                      <td>
                        <div className="acct_vis_cell">
                          {constellation}
                          <AccountVisibilityToggle
                            field="constellation"
                            label="星座"
                            switchText="在主页展示星座"
                            initialHidden={user.constellationHidden}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  {rows.map(([label, value]) => (
                    <tr key={label}>
                      <th>{label}</th>
                      <td>
                        <div>
                          {value}
                          {label === "QQ" && QQ_OAUTH_ENABLED && (
                            qqBinding ? (
                              <span className="bind_email_btn qq_bound">
                                已绑定{qqBinding.nickname ? ` ${qqBinding.nickname}` : ""}
                              </span>
                            ) : (
                              <QqBindLink />
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {/* 赞助金额（2026-11-10 张老师）：鼠标垫行后独立一行，仅赞助过才显示；
                      行尾「在主页展示金额」开关控制个人主页数据统计的赞助金额行 */}
                  {donateCents > 0 && (
                    <tr>
                      <th>赞助金额</th>
                      <td>
                        <div className="acct_vis_cell">
                          {/* 金色（2026-11-10 张老师）：同个人主页统计盒赞助金额口径 */}
                          <span className="donate_gold">{donateYuanPlain(donateCents)}</span>
                          <AccountVisibilityToggle
                            field="donate"
                            label="赞助金额"
                            switchText="在主页展示金额"
                            initialHidden={user.donateHidden}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  {/* 开源扫雷网绑定（2026-11-09 绑定协议 v2：入口行，流程走 /account/openms/bind）。
                      2026-11-10 张老师：已绑定态改绿色「已绑定」+ hover 气泡（开源扫雷网用户 #编号），
                      同步开关挪进行内，文案改「自动同步录像到扫雷网」 */}
                  <tr>
                    <th>开源扫雷网</th>
                    <td>
                      <div>
                        {openmsLink ? (
                          <div className="openms_bound_cell">
                            <span
                              className="openms_bound_tag"
                              data-tip={`开源扫雷网用户 #${openmsLink.profile}`}
                            >
                              已绑定
                            </span>
                            <OpenmsBindPrefs
                              initialConsent={openmsLink.consent === 1}
                              label="自动同步录像到扫雷网"
                              hint=""
                              inline
                            />
                          </div>
                        ) : (
                          <Link href="/account/openms/bind" className="bind_email_btn">
                            绑定开源扫雷网
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {/* （2026-11-10 张老师：原页面底部「显示年龄与星座」「公开赞助金额」两个独立开关
                已移入年龄/星座/赞助金额行尾的「在我的主页展示」行内开关） */}
            {/* 绑定结果反馈（弹窗授权完成后主窗跳回 /account?bound=1 / ?error=taken） */}
            {sp.bound === "1" && <p className="account_flash ok">QQ 绑定成功，今后点登录框的企鹅图标即可登录</p>}
            {sp.error === "taken" && <p className="account_flash err">该 QQ 已绑定其他账号，请换一个试试</p>}
            {/* 本人已有照片时问一句：要不要换成 QQ 头像（2026-10-27 张老师要求）。
                浮窗自己把 URL 上的 qqavatar 抹掉，只问一次。 */}
            {sp.qqavatar === "1" && qqBinding?.avatar && (
              <QqAvatarPrompt currentUrl={photo} qqUrl={qqBinding.avatar} />
            )}
          </div>
        </li>
        <li className="sidebar">
          {/* hideRadar：卡片下只放玩家卡片，不放实力雷达/数据统计（2026-10-16 张老师定） */}
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
