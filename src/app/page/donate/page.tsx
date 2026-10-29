// 提供赞助（2026-10-15 重设计：双收款码卡片布局，文案移植 2008 版 About/Donate.asp）
import Link from "next/link";

export const metadata = { title: "提供赞助" };

export default function DonatePage() {
  return (
    <div id="page" className="main narrow">
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
        <p className="pay_alone">
          支付宝账号：<em>137516@qq.com</em>（也可转账，请注明「扫雷网+用户ID」）
        </p>

        <h2>【赞助用途】</h2>
        <p>
          1、服务器租赁、带宽及域名费用
          <br />
          2、开发人力成本+AI Token成本
          <br />
          3、官方比赛奖金
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
        <p>4、请不要将赞助金额发布在论坛或 QQ 群中，如需核实款项请和站长张砷镓联系。</p>

        <p className="donate_back">
          <Link href="/page/help" className="button active">
            返回新手上路
          </Link>
        </p>
      </div>
    </div>
  );
}
