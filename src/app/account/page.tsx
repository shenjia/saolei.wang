// 账号中心 · 我的资料（移植 views/account/center）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { AccountHeader } from "@/components/AccountHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "账号中心 | 扫雷网" };

export default async function AccountCenterPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const detail = await getUserDetail(session.uid);
  if (!detail) redirect("/account/login");
  const { user, info } = detail;

  const rows: [string, string][] = [
    ["中文名", user.chineseName],
    ["英文名", user.englishName],
    ["爱好", info?.interest ?? ""],
    ["QQ", info?.qq ?? ""],
    ["昵称", info?.nickname ?? ""],
    ["鼠标", info?.mouse ?? ""],
    ["鼠标垫", info?.pad ?? ""],
  ];

  return (
    <div id="page" className="two_columns">
      <ul id="account_center">
        <li className="main">
          <div className="box">
            <AccountHeader />
            <table className="form" cellPadding={0} cellSpacing={0}>
              <tbody>
                {rows.map(([label, value]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </li>
        <li className="sidebar">
          <div className="box user_info_cell">
            <h2>
              <Link href={`/user/${user.id}`}>{user.chineseName}</Link>
            </h2>
            <p className="title_line">{detail.title}</p>
          </div>
        </li>
      </ul>
    </div>
  );
}
