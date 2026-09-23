// 每日一星评选方法（移植 2008 版 Help/Star.asp）
import Link from "next/link";

export const metadata = { title: "每日一星评选方法 | 扫雷网" };

export default function StarHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>每日一星评选方法</h1>
        <p>
          「每日一星」是为了鼓励雷友们增进水平设立的栏目。由系统每日在
          <strong>神界</strong>全员与<strong>人界</strong>排名有进步的雷友中随机产生一位。
          当选过一次的雷友不再参与本月接下来的每日一星评选。
        </p>
        <p>您只要努力提高排名或者升入神界，就有机会成为每日之星啦！</p>
        <hr />
        <Link href="/" className="button active">
          返回首页
        </Link>
      </div>
    </div>
  );
}
