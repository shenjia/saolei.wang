// 怎样提高扫雷水平（移植 2008 版 Help/Grow.asp）
import Link from "next/link";

export const metadata = { title: "怎样提高扫雷水平 | 扫雷网" };

export default function GrowPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>怎样提高扫雷水平</h1>
        <p>1、选择适合自己的鼠标、鼠标垫。</p>
        <p>2、选择适合自己的鼠标速度和屏幕分辨率。</p>
        <p>
          3、多看网站上的<Link href="/page/guide">教程</Link>，提升思路。
        </p>
        <p>4、多看比自己厉害的录像，找到差距。</p>
        <p>5、多多练习，将学到看到的变成自己的。</p>
        <hr />
        <Link href="/page/help" className="button active">
          返回新手上路
        </Link>
      </div>
    </div>
  );
}
