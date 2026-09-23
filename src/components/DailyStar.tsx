// 每日一星（移植 2008 版 Player/Star.asp）：首页右栏展示

import Link from "next/link";
import { getTodayStar } from "@/lib/star";
import { AvatarCell } from "@/components/Cells";

export async function DailyStar() {
  const star = await getTodayStar();
  if (!star?.user) return null;
  return (
    <div id="daily_star" className="box">
      <Link href="/page/help/star" target="_blank">
        <h2>每日一星</h2>
      </Link>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <tr>
            <td className="user" style={{ textAlign: "center" }}>
              <AvatarCell id={star.user.id} name={star.user.chineseName} sex={star.user.sex} link />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
