// 软件下载（移植 2008 版 Download/Index.asp，安装包已从线上旧站迁入 public/download/）
import Link from "next/link";

export const metadata = { title: "软件下载 | 扫雷网" };

const SOFTWARE: [string, string, [string, string][]?][] = [
  ["Minesweeper Arbiter 0.52.3", "Arbiter_0.52.3.zip", [["教程", "/page/guide"], ["中文插件", "/download/Arbiter_cn.zip"]]],
  ["Minesweeper Clone 0.97", "Minesweeper_Clone_0.97.exe", [["使用说明", "/page/guide"], ["常见问题", "/page/help/clone-faq"]]],
  ["Minesweeper Clone 2007", "Minesweeper_Clone_2007.exe"],
  ["Minesweeper X 1.15", "MinesweeperX_1.15.zip"],
  ["Viennasweeper 3.0", "Viennasweeper_3.0.zip"],
  ["Minesweeper 2000/XP", "Minesweeper_2000XP.exe"],
  ["Minesweeper Solver", "MineSweeper_Solver.exe"],
  ["扫雷网分辨率调整工具", "分辨率调整工具.exe"],
  ["扫雷网地图转换工具", "地图转换工具.rar"],
  ["Android录像播放器 2.0.2", "MPlayer_v2.0.2.apk"],
  ["Android雷感训练器 1.0.19", "NotMinesweeper_V1.0.19.apk"],
];

export default function DownloadPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>软件下载</h1>
        {SOFTWARE.map(([name, file, extra]) => (
          <p key={name}>
            <a href={`/download/${encodeURIComponent(file)}`} download>
              {name}
            </a>
            {extra?.map(([label, href]) => (
              <span key={label}>
                {" "}
                （{href.startsWith("/download/") ? <a href={href}>{label}</a> : <Link href={href}>{label}</Link>}）
              </span>
            ))}
          </p>
        ))}
        <hr />
        <Link href="/page/help" className="button active">
          返回新手上路
        </Link>
      </div>
    </div>
  );
}
