// 管理后台 · 赞助管理（2026-10-30）
// 上半区：登记赞助（ID 可选自动识别 + 金额）；下半区：赞助清单（时间 / 人名+军衔 / 金额）。
// 前台赞助页底部展示同一份清单（lib/donate.ts 共用）。

import Link from "next/link";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { getDonateList, donateYuan } from "@/lib/donate";
import { formatDate } from "@/lib/format";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminCard } from "@/components/admin/Widgets";
import { DonateForm } from "@/components/admin/DonateForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "赞助管理 | 管理后台" };

export default async function AdminDonatePage() {
  const { rows, totalCents, total } = await getDonateList(200);

  return (
    <>
      <div className="admin_page_head">
        <h1>赞助管理</h1>
        <span className="sub">
          共 {total} 笔 · 累计 {donateYuan(totalCents)}
        </span>
      </div>

      <AdminCard title="登记赞助">
        <div className="admin_note" style={{ marginBottom: 10 }}>
          收款到账后在此登记：填写玩家 ID（自动识别），留空即为匿名赞助；金额单位为元（可带小数）。
        </div>
        <DonateForm />
      </AdminCard>

      <AdminCard title="赞助清单" tight>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>时间</th>
                <th>雷友</th>
                <th className="num">金额</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="c sub">{r.id}</td>
                  <td className="sub">{formatDate(r.createTime, "Y-m-d H:i")}</td>
                  <td>
                    {r.user > 0 && r.chineseName ? (
                      <>
                        <Link className="link" href={`/admin/users/${r.user}`}>
                          {r.chineseName}
                          <span className="pt_bubble">
                            #{r.user}
                            {r.englishName ? ` ${r.englishName}` : ""}
                          </span>
                        </Link>{" "}
                        <TitleBadge title={r.militaryTitle ?? ""} classic={r.classic} />
                      </>
                    ) : (
                      <span className="sub">{r.user > 0 ? `#${r.user}（已删号）` : "匿名雷友"}</span>
                    )}
                  </td>
                  <td className="num">{donateYuan(r.amount)}</td>
                  <td className="ops">
                    <AdminAction
                      op="donate.delete"
                      params={{ id: r.id }}
                      label="删除"
                      variant="danger"
                      confirm={`确认删除这条赞助记录？\n${r.user > 0 && r.chineseName ? r.chineseName : "匿名雷友"} ${donateYuan(r.amount)}（记录 #${r.id}，不可恢复）`}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="admin_empty">还没有赞助记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 赞助通过<a href="/page/donate" target="_blank" rel="noopener noreferrer"> 赞助页 </a>收款码线下到账，管理员在此手动记账；<br />
          · 金额以元输入、以分落库（沿用 2013 版 donate 表口径），前台赞助页底部展示同一份清单；<br />
          · 匿名赞助（不填 ID）日后推出 VIP 等收费项目时不予等额充值（赞助页注意事项第 3 条）。
        </div>
      </AdminCard>
    </>
  );
}
