// 为什么录像会被冻结（移植 2008 版 Help/Freeze.asp，适配新版「屏蔽」语义）
import Link from "next/link";

export const metadata = { title: "为什么录像会被屏蔽 | 扫雷网" };

export default function FreezeHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>为什么录像会被屏蔽？</h1>
        <p>
          1、上传的录像没有设置录像标识文字。
          <br />
          例：标识文字为软件默认的 Your name here...Press F5，这样无法判定录像的归属。
        </p>
        <p>
          2、上传的录像标识文字与用户注册的录像标识文字不符。
          <br />
          例：用户注册的标识为 Zhang San，而录像的标识文字为 Li Si。
        </p>
        <p>
          3、录像数据异常。
          <br />
          例：录像的级别、时间、3BV 与正常范围不符。
        </p>
        <p>
          4、录像非 Classical Mode 模式。
          <br />
          例：上传了 UPK Mode 或者 Density Mode 模式的录像。
        </p>
        <p>
          5、录像存在 BUG。
          <br />
          例：录像完成后仍有未打开的方块，或者每次播放显示的完成时间都不同。
        </p>
        <p>
          6、录像无法打开。
          <br />
          例：错传了其他文件或者上传了损坏的录像文件。
        </p>
        <p>如对审核结果有疑问，请在录像详情页留言或与管理员联系。</p>
        <hr />
        <Link href="/video" className="button active">
          明白了，我要继续看录像
        </Link>
      </div>
    </div>
  );
}
