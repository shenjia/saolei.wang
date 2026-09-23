// 我们为什么玩扫雷（移植 2008 版 Help/Why.asp）
import Link from "next/link";

export const metadata = { title: "我们为什么玩扫雷 | 扫雷网" };

export default function WhyPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>我们为什么玩扫雷</h1>
        <p>1、任何一台电脑上只要有 Windows 就有扫雷，因此扫雷拥有世界上最大的玩家群体。</p>
        <p>2、扫雷不用花钱也可以玩。</p>
        <p>3、扫雷不用上网也可以玩。</p>
        <p>4、扫雷不用电脑配置很高也可以玩。</p>
        <p>5、扫雷可以锻炼你的逻辑思维能力、抽象思维能力、想象力、判断力、反应速度。</p>
        <hr />
        <Link href="/page/help" className="button active">
          返回新手上路
        </Link>
      </div>
    </div>
  );
}
