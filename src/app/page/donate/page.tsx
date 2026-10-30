// 提供赞助（2026-10-15 重设计：双收款码卡片布局，文案移植 2008 版 About/Donate.asp）
// 2026-10-30 二轮（张老师）：赞助清单从底部移到右侧独立板块，标题「赞助记录」；
// 页面骨架改 two_columns 两栏（与用户主页/录像详情/论坛详情同款），左栏保持原文案版式。

import { AvatarCell, TitleBadge } from "@/components/Cells";
import { getDonateList, donateYuan } from "@/lib/donate";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "提供赞助" };

export default async function DonatePage() {
  const { rows, totalCents, total } = await getDonateList(200);

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
          {/* 右侧独立板块：赞助记录（2026-10-30 二轮，与后台赞助管理同一数据源） */}
          <div className="box donate_side">
            <h2>赞助记录</h2>
            {rows.length > 0 ? (
              <>
                <table cellPadding={0} cellSpacing={0} className="table donate_table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>雷友</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="sub">{formatDate(r.createTime, "Y-m-d")}</td>
                        <td>
                          {r.user > 0 && r.chineseName ? (
                            <span className="donate_who">
                              <AvatarCell
                                id={r.user}
                                name={r.chineseName}
                                englishName={r.englishName ?? undefined}
                                sex={r.sex}
                                link
                              />
                              <TitleBadge title={r.militaryTitle ?? ""} classic={r.classic} />
                            </span>
                          ) : (
                            <span className="sub">{r.user > 0 ? `#${r.user}` : "匿名雷友"}</span>
                          )}
                        </td>
                        <td>
                          <em>{donateYuan(r.amount)}</em>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="donate_total">
                  共 {total} 笔，累计 <em>{donateYuan(totalCents)}</em>
                </p>
              </>
            ) : (
              <p className="donate_empty">暂无赞助记录</p>
            )}
          </div>
        </li>
      </ul>
    </div>
  );
}
