// 管理团队（移植 2008 版 Team/Index.asp：管理员名单 + 各自审核录像工作量）

import { getTeam } from "@/lib/queries";
import { USER_ROLE } from "@/lib/config";
import { AvatarCell } from "@/components/Cells";

export const dynamic = "force-dynamic";
export const metadata = { title: "管理团队 | 扫雷网" };

export default async function TeamPage() {
  const team = await getTeam();
  return (
    <div id="page" className="main">
      <div className="box">
        <h1>管理团队</h1>
        <table cellPadding={0} cellSpacing={0} className="table">
          <thead>
            <tr>
              <th>成员</th>
              <th>职务</th>
              <th>审核录像数</th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.id}>
                <td className="user">
                  <AvatarCell id={m.id} name={m.chineseName} sex={m.sex} link />
                </td>
                <td>{m.role === USER_ROLE.ADMINISTRATOR ? "站长" : "管理员"}</td>
                <td>
                  <em>{m.reviewCount}</em>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
