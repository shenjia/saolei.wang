// 新手上路（移植 views/site/pages/help.php）
// 注册成功后旧版会引导到此页

import Link from "next/link";

export const metadata = { title: "新手上路 | 扫雷网" };

export default function HelpPage() {
  return (
    <div id="page" className="main">
      <div id="help" className="box text">
        <h1>新手上路</h1>

        <h2>
          欢迎加入本站的QQ群：<em>54708610</em>
          ，您遇到的任何问题都可以在这里得到解答。
        </h2>
        <p>1、如何观看录像？</p>
        <p>2、如何加入排行？</p>
        <p>3、怎样提高扫雷水平？</p>
        <p>4、3BV和NF等术语什么意思？</p>
        <hr />
        <Link href="/" className="button active">
          首页
        </Link>
      </div>
    </div>
  );
}
