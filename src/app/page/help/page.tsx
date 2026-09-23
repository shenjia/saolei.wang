// 新手上路 · 如何加入排行（移植 2008 版 Help/Ranking.asp）
import Link from "next/link";

export const metadata = { title: "新手上路 | 扫雷网" };

const TOPICS: [string, string][] = [
  ["/page/help/why", "我们为什么玩扫雷？"],
  ["/page/help/grow", "怎样提高我的扫雷水平？"],
  ["/page/help/word", "3BV、NF 等术语是什么意思？"],
  ["/page/help/video", "如何观看本网站的录像？"],
  ["/page/help/upload", "上传录像须知与 3BV 查看方法"],
  ["/page/help/freeze", "为什么录像会被冻结？"],
  ["/page/help/star", "每日一星评选方法"],
  ["/page/help/clone-faq", "Minesweeper Clone 0.97 常见问题"],
  ["/page/help/bbs", "论坛管理条例"],
  ["/page/help/email", "如何给世界排行发邮件（A mail to Damien）"],
  ["/page/help/avatar", "怎样上传我的照片？"],
  ["/page/titles", "雷界称号说明"],
];

export default function HelpPage() {
  return (
    <div id="page" className="main">
      <div id="help" className="box text">
        <h1>新手上路 · 如何加入排行</h1>

        <h2>一、下载并安装扫雷软件</h2>
        <p>
          请先到 <Link href="/page/download">软件下载</Link> 页下载 Minesweeper Arbiter
          或 Minesweeper Clone。下载后解压缩并进入游戏，如果遇到问题，请到论坛提问。
        </p>

        <h2>二、设置录像标识文字</h2>
        <p>进入游戏后按 F5，可进入设置界面。</p>
        <p>
          在 Show Player Identification Text 选项下面的输入框中设置录像标识文字。
        </p>
        <p>
          录像标识文字只能使用英文，推荐使用姓名拼音附加地区拼音，例如：Wang Wei (Shan Xi)。
        </p>
        <p>如果您注册时不慎填错了录像标识文字，可与管理员联系进行更改。</p>
        <p>如果您上传了成绩后想更改录像标识文字，必须放弃已有的成绩。</p>

        <h2>三、保存扫雷录像</h2>
        <p>每次突破记录后软件会将录像自动保存在软件目录下。</p>

        <h2>四、查看录像数据</h2>
        <p>
          在播放录像时，或完成游戏后，游戏主界面旁边的统计窗口会显示录像的各项数据。
        </p>
        <p>其中最重要的是 3BV 和 Time，这是上传录像时必须填写的数据。</p>

        <h2>五、上传扫雷录像</h2>
        <p>
          登录扫雷网，点击导航栏的 <Link href="/video/upload">上传</Link>。
        </p>
        <p>
          选择录像文件即可，系统会自动解析出级别、时间和 3BV。
          经审核后的录像将计入个人扫雷成绩，系统将自动取各级别的最短时间和最高 3BV/S 作为纪录保存。
        </p>
        <p>
          当初/中/高三个级别的时间和 3BV/S 成绩都有纪录后，系统自动将您纳入国内扫雷排行。
        </p>

        <hr />
        <h2>常见问题</h2>
        {TOPICS.map(([href, label]) => (
          <p key={href}>
            <Link href={href}>{label}</Link>
          </p>
        ))}
        <hr />
        <Link href="/" className="button active">
          我明白了，回首页
        </Link>
      </div>
    </div>
  );
}
