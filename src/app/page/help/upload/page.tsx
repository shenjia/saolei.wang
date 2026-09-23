// 上传录像须知 + 3BV 查看方法（移植 2008 版 Help/Upload_Rule.asp + Upload_3BV.asp）
import Link from "next/link";

export const metadata = { title: "上传录像须知 | 扫雷网" };

export default function UploadHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>上传录像须知</h1>
        <p>※ 可接受的初级最低 3BV 为 2，中级最低 3BV 为 25，高级最低 3BV 为 100。</p>
        <p>※ 3BV 小于 4 的初级录像只计算时间成绩，不计算 3BV/S 成绩。</p>
        <p>※ 本站上传时会自动解析录像文件的级别、时间、3BV，数据与录像不符的将无法上传。</p>
        <p>※ 请确保上传录像的标识文字和注册的标识文字相符，否则将无法上传。</p>
        <p>※ 只允许上传 Classic Mode 模式的录像，其他模式如 UPK Mode 的录像将不予审核通过。</p>
        <p>※ 所有上传录像经审核通过方能生效，审核不予通过的录像将被屏蔽。</p>
        <p>※ 上传录像后请密切关注录像的审核情况。</p>

        <h2>怎样查看录像 3BV 值？</h2>
        <p>运行 Minesweeper Clone 0.97。</p>
        <p>在 Option 菜单中勾选 Show counter window，即可在播放录像时查看统计数据。</p>
        <p>在 Option 菜单中勾选 Show 3BV stats，即可查看 3BV 数值。</p>
        <hr />
        <Link href="/video/upload" className="button active">
          明白了，我要继续上传录像
        </Link>
      </div>
    </div>
  );
}
