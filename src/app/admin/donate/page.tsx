// 管理后台 · 收支管理（2026-10-30 二期：原赞助管理扩展为左右分栏）
// 左：赞助（登记表单 + 清单）；右：支出（用途/金额/凭据图登记 + 清单）。
// 前台赞助页展示同一份数据（lib/donate.ts 共用）。

import Link from "next/link";
import { TitleBadge } from "@/components/Cells";
import { getDonateList, getExpenseList, donateYuan } from "@/lib/donate";
import { formatDate } from "@/lib/format";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminCard } from "@/components/admin/Widgets";
import { DonateForm } from "@/components/admin/DonateForm";
import { ExpenseForm } from "@/components/admin/ExpenseForm";
import { RowEditButton } from "@/components/admin/RowEditButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "收支管理 | 管理后台" };

export default async function AdminDonatePage() {
  const [{ rows, totalCents, total }, expense] = await Promise.all([getDonateList(200), getExpenseList(200)]);
  const balance = totalCents - expense.totalCents;

  return (
    <>
      <div className="admin_page_head">
        <h1>收支管理</h1>
        <span className="sub">
          收入 <b style={{ color: "#e6b422" }}>+{donateYuan(totalCents)}</b>（{total} 笔） · 支出{" "}
          <b style={{ color: "#f92672" }}>-{donateYuan(expense.totalCents)}</b>（{expense.total} 笔） · 结余{" "}
          <b style={{ color: balance >= 0 ? "#a6e22e" : "#f92672" }}>
            {balance >= 0 ? donateYuan(balance) : `-${donateYuan(-balance)}`}
          </b>
        </span>
      </div>

      <div className="donate_columns">
        {/* 左栏：赞助 */}
        <div className="donate_col">
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
                            {/* 雷友名前显示 #ID（2026-10-30 张老师）；气泡只留英文名 */}
                            <Link className="link" href={`/admin/users/${r.user}`}>
                              <span className="sub">#{r.user}</span> {r.chineseName}
                              {r.englishName ? (
                                <span className="pt_bubble"> {r.englishName}</span>
                              ) : null}
                            </Link>{" "}
                            <TitleBadge title={r.militaryTitle ?? ""} classic={r.classic} />
                          </>
                        ) : (
                          <span className="sub">{r.user > 0 ? `#${r.user}（已删号）` : "匿名雷友"}</span>
                        )}
                      </td>
                      <td className="num" style={{ color: "#e6b422" }}>+{donateYuan(r.amount)}</td>
                      <td className="ops">
                        {/* 编辑：派发事件给上方 DonateForm 回填进入编辑模式 */}
                        <RowEditButton
                          event="sl-donate-edit"
                          detail={{ id: r.id, user: r.user, amount: r.amount, createTime: r.createTime }}
                        />{" "}
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
        </div>

        {/* 右栏：支出 */}
        <div className="donate_col">
          <AdminCard title="登记支出">
            <div className="admin_note" style={{ marginBottom: 10 }}>
              站点花销在此登记：填写用途与金额，可上传票据/转账截图作为凭据（前台支出记录展示票据图标，点击可查看）。
            </div>
            <ExpenseForm />
          </AdminCard>

          <AdminCard title="支出清单" tight>
            <div className="admin_scroll">
              <table className="admin_table">
                <thead>
                  <tr>
                    <th className="c">ID</th>
                    <th>时间</th>
                    <th>用途</th>
                    <th className="num">金额</th>
                    <th className="c">凭据</th>
                    <th className="ops">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {expense.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="c sub">{r.id}</td>
                      <td className="sub">{formatDate(r.createTime, "Y-m-d H:i")}</td>
                      <td>{r.purpose}</td>
                      <td className="num" style={{ color: "#f92672" }}>-{donateYuan(r.amount)}</td>
                      <td className="c">
                        {r.evidence ? (
                          <a className="link" href={r.evidence} target="_blank" rel="noopener noreferrer" title="查看凭据">
                            🧾
                          </a>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td className="ops">
                        {/* 编辑：派发事件给上方 ExpenseForm 回填进入编辑模式 */}
                        <RowEditButton
                          event="sl-expense-edit"
                          detail={{
                            id: r.id,
                            purpose: r.purpose,
                            amount: r.amount,
                            evidence: r.evidence,
                            createTime: r.createTime,
                          }}
                        />{" "}
                        <AdminAction
                          op="expense.delete"
                          params={{ id: r.id }}
                          label="删除"
                          variant="danger"
                          confirm={`确认删除这条支出记录？\n${r.purpose} ${donateYuan(r.amount)}（记录 #${r.id}，不可恢复）`}
                        />
                      </td>
                    </tr>
                  ))}
                  {expense.rows.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        <div className="admin_empty">还没有支出记录</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </AdminCard>
        </div>
      </div>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 赞助通过<a href="/page/donate" target="_blank" rel="noopener noreferrer"> 赞助页 </a>收款码线下到账，管理员在此手动记账；<br />
          · 金额以元输入、以分落库（沿用 2013 版 donate 表口径），前台赞助页展示同一份收支清单；<br />
          · 匿名赞助（不填 ID）日后推出 VIP 等收费项目时不予等额充值（赞助页注意事项第 3 条）；<br />
          · 支出凭据图存 public/uploads/expense/，仅收本站上传 URL（ops 白名单校验）。
        </div>
      </AdminCard>
    </>
  );
}
