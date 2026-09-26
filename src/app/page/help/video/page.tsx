// 怎么看录像（移植 2008 版 Help/Video.asp）
import Link from "next/link";

export const metadata = { title: "怎么看录像 | 扫雷网" };

export default function VideoHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>怎么看录像？</h1>
        <p>
          本站录像详情页支持<strong>在线播放</strong>，无需安装任何软件，点击「播放」按钮即可在网页中回放。
        </p>
        <p>如需在本地软件中观看：</p>
        <p>
          要观看 avf 录像，请先下载 Minesweeper Arbiter；要观看 mvf 录像，请先下载 Minesweeper
          Clone 0.97 并安装（均见<Link href="/page/download">软件下载</Link>页）。
        </p>
        <p>打开网站上任何一个录像，点击「下载录像」，将录像保存到桌面上。</p>
        <p>双击保存下来的录像文件，选择打开方式：</p>
        <p>mvf 录像浏览到 Clone 的安装目录，选择 Minesweeper Clone.exe。</p>
        <p>avf 录像浏览到 Arbiter 的所在目录，选择 ms_arbiter.exe。</p>
        <p>选择「始终使用选择的程序打开这种文件」。</p>
        <p>好了，以后双击录像文件即可直接播放。</p>
        <hr />
        <Link href="/video" className="button active">
          明白了，我要继续看录像
        </Link>
      </div>
    </div>
  );
}
