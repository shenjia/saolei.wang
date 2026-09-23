// A mail to Damien（移植 2008 版 Help/Email.asp）
import Link from "next/link";

export const metadata = { title: "给世界排行发邮件 | 扫雷网" };

export default function EmailHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>A mail to Damien</h1>
        <p>
          <em>标题：</em>I&apos;m a new player from China...
        </p>
        <p>
          <em>正文：</em>
          <br />
          Hello, Damien!
          <br />
          My name is Zhang Shen Jia, I come from China - Shaanxi, here is my score :)
        </p>
        <p>
          <em>附件：</em>
          <br />
          Beg(2007-1-23).mvf
          <br />
          Int(2007-8-7).mvf
          <br />
          Exp(2007-10-23).mvf
        </p>
        <p>
          <em>要点：</em>
          <br />
          1、说明自己的姓名、所在地区
          <br />
          2、附件包括初级、中级、高级三个录像
          <br />
          3、录像名包括该录像生成的时间
        </p>
        <p>鄙人英语不精，还望达人能给出更好的示范信，谢谢 :)　by 张砷镓</p>
        <hr />
        <Link href="/page/help" className="button active">
          我知道 Mail 怎么写了
        </Link>
      </div>
    </div>
  );
}
