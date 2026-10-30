// 提供赞助（2026-10-15 重设计：双收款码卡片布局，文案移植 2008 版 About/Donate.asp）
// 2026-10-30 二轮（张老师）：赞助清单从底部移到右侧独立板块，标题「赞助记录」；
// 页面骨架改 two_columns 两栏（与用户主页/录像详情/论坛详情同款），左栏保持原文案版式。
// 2026-10-30 收支管理：赞助记录下方加「支出记录」（时间/用途/金额+票据图标，
// 点击弹遮罩浮层查看凭据图），数据与后台收支管理同源（lib/donate.ts）。

import Link from "next/link";
import { PlayerTip } from "@/components/Cells";
import { ExpenseEvidence } from "@/components/ExpenseEvidence";
import { ExpandableItems } from "@/components/ExpandableItems";
import { getDonateList, getExpenseList, donateYuanPlain } from "@/lib/donate";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "提供赞助" };

export default async function DonatePage() {
  const [{ rows, totalCents, total }, expense] = await Promise.all([getDonateList(200), getExpenseList(200)]);
  const balance = totalCents - expense.totalCents;

  // 赞助时间显示（2026-10-30 张老师终版）：全部显示日期，不做相对时间
  const donateTime = (t: number) => formatDate(t, "Y-m-d");

  return (
    <div id="page" className="two_columns">
      <ul id="home">
        <li className="main">
          <div className="box text">
            <h1>提供赞助</h1>
            <p>
              本站一直由站长张砷镓进行独立维护。希望有经济能力的雷友对本站进行赞助，使本站能维持运行，并不断发展。
            </p>

            <div className="pay_row">
              <div className="pay_card wechat">
                <div className="pay_name">微信收款</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/donate/wechat-qr.png" alt="微信收款码" width={210} height={210} />
                <div className="pay_hint">微信「扫一扫」即可赞助</div>
              </div>
              <div className="pay_card alipay">
                <div className="pay_name">支付宝收款</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/donate/alipay-qr.png" alt="支付宝收款码" width={210} height={210} />
                <div className="pay_hint">支付宝「扫一扫」即可赞助</div>
              </div>
            </div>

            <h2>【赞助用途】</h2>
            <p>
              1、支付服务器租赁、带宽及域名费用
              <br />
              2、覆盖开发人力成本+AI Token成本
              <br />
              3、如有盈余，将作为官方比赛奖金
            </p>

            <h2>【注意事项】</h2>
            <p>1、赞助应在不影响生活质量的情况下，量力而行。建议在校学生在工作后再进行赞助！</p>
            <p>
              2、请在付款说明中注明「扫雷网+用户ID」（如：扫雷网 54），否则款项将流失，无法计入赞助。
            </p>
            <p>
              3、日后本站推出收费项目（如 VIP 会员）时，将对赞助用户充值对应的金额，如果不填写 ID
              则视为匿名赞助，放弃日后等额充值的权利。
            </p>
          </div>
        </li>
        <li className="sidebar">
          {/* 收支统计（2026-10-30 六轮张老师）：右栏顶端三行——收入/支出/结余；
              收入绿色、支出金色，结余正数绿、负数红 */}
          <div className="box donate_side stats_side">
            <div className="donate_head">
              <h2>收支统计</h2>
            </div>
            <div className="stats_rows">
              {/* 2026-10-30 张老师：标签「总计收入/支出/结余」深灰；收入数字绿色带 + 号、
                  支出数字带 - 号（玫瑰红）；结余正绿负红 */}
              <div className="stat_row">
                <span className="stat_label">总计收入</span>
                <em className="stat_val stat_income">+{donateYuanPlain(totalCents)}</em>
              </div>
              <div className="stat_row">
                <span className="stat_label">总计支出</span>
                <em className="stat_val stat_expense">-{donateYuanPlain(expense.totalCents)}</em>
              </div>
              <div className="stat_row">
                <span className="stat_label">总计结余</span>
                <em className={`stat_val ${balance >= 0 ? "stat_balance_pos" : "stat_balance_neg"}`}>
                  {balance >= 0 ? donateYuanPlain(balance) : `-${donateYuanPlain(-balance)}`}
                </em>
              </div>
            </div>
          </div>

          {/* 右侧独立板块：赞助记录（2026-10-30 二轮，与后台赞助管理同一数据源） */}
          <div className="box donate_side">
            {/* 五轮（张老师）：「共 x 笔」上移板块标题行右上角（h2 同行，flex 两端对齐）；四轮定的无表头/无总金额维持 */}
            <div className="donate_head">
              <h2>赞助记录</h2>
              <span className="donate_count">共 {total} 笔</span>
            </div>
            {rows.length > 0 ? (
              /* 2026-10-30 四轮（张老师）：不放表头；不显示总金额。
                 六轮：默认只显最近 5 条，「…」展开全部/「收起」还原（ExpandableItems） */
              <ExpandableItems
                mode="table"
                wrapClass="donate_table"
                items={rows.map((r) => (
                  <tr key={r.id}>
                    {/* 日期移回最前（2026-10-30 张老师），全部显示日期（不做相对时间） */}
                    <td className="sub">{donateTime(r.createTime)}</td>
                    <td>
                      {r.user > 0 && r.chineseName ? (
                        /* 2026-10-30 三轮（张老师）：只显示人名——不出性别标记与军衔；
                           人名保留玩家气泡（#ID 姓名 英文名），avatar_link 同站内配色 */
                        <Link href={`/user/${r.user}`} className="avatar_link" target="_blank" prefetch={false}>
                          {r.chineseName}
                          <span className="pt_bubble">
                            <PlayerTip id={r.user} name={r.chineseName} englishName={r.englishName ?? undefined} />
                          </span>
                        </Link>
                      ) : (
                        <span className="sub">{r.user > 0 ? `#${r.user}` : "匿名雷友"}</span>
                      )}
                    </td>
                    <td className="donate_amt">
                      {/* 赞助金额带 + 号（2026-10-30 张老师，与支出 - 号对称） */}
                      <em>+{donateYuanPlain(r.amount)}</em>
                    </td>
                  </tr>
                ))}
              />
            ) : (
              <p className="donate_empty">暂无赞助记录</p>
            )}
          </div>

          {/* 支出记录（2026-10-30 收支管理）：赞助记录下方同一数据源；复用 donate_side 排版，
              有凭据的支出带票据图标，点击弹遮罩浮层查看（ExpenseEvidence 客户端组件） */}
          <div className="box donate_side expense_side">
            <div className="donate_head">
              <h2>支出记录</h2>
              <span className="donate_count">共 {expense.total} 笔</span>
            </div>
            {expense.rows.length > 0 ? (
              /* 2026-10-30 三轮（张老师）：每笔两行——日期+用途一行，费用+凭据一行。
                 六轮：默认只显最近 5 条，「…」展开全部/「收起」还原（ExpandableItems） */
              <ExpandableItems
                mode="list"
                wrapClass="expense_list"
                items={expense.rows.map((r) => (
                  <div key={r.id} className="expense_item">
                    {/* 2026-10-30 张老师：日期移回最前（只显示到月），用途居中，金额+凭据贴右 */}
                    <div className="expense_line">
                      <span className="sub">{formatDate(r.createTime, "Y-m")}</span>
                      <span className="expense_purpose">{r.purpose}</span>
                      <span className="expense_pay">
                        <em className="expense_amt">-{donateYuanPlain(r.amount)}</em>
                        {r.evidence && <ExpenseEvidence url={r.evidence} alt={r.purpose} />}
                      </span>
                    </div>
                  </div>
                ))}
              />
            ) : (
              <p className="donate_empty">暂无支出记录</p>
            )}
          </div>
        </li>
      </ul>
    </div>
  );
}
