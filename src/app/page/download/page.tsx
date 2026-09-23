// 软件下载（移植 2008 版 Download/Index.asp）
// 安装包实体仍在旧站（saolei.net/Download/），链接先指向旧站，迁移文件后改为本地
import Link from "next/link";

export const metadata = { title: "软件下载 | 扫雷网" };

const OLD = "http://www.saolei.net/Download/";

const SOFTWARE: [string, string, [string, string][]?][] = [
  ["Minesweeper Arbiter 0.52.3", "Arbiter_0.52.3.zip", [["教程", "/page/guide"], ["中文插件", "/page/guide"]]],
  ["Minesweeper Clone 0.97", "Minesweeper_Clone_0.97.exe", [["使用说明", "/page/guide"], ["常见问题", "/page/help/clone-faq"]]],
  ["Minesweeper Clone 2007", "Minesweeper_Clone_2007.exe"],
  ["Minesweeper X 1.15", "MinesweeperX_1.15.zip"],
  ["Viennasweeper 3.0", "Viennasweeper_3.0.zip"],
  ["Minesweeper 2000/XP", "Minesweeper_2000XP.exe"],
  ["Minesweeper Solver", "MineSweeper_Solver.exe"],
  ["扫雷网分辨率调整工具", "%B7%D6%B1%E6%C2%CA%B5%F7%D5%FB%B9%A4%BE%DF.exe"],
  ["扫雷网地图转换工具", "%B5%D8%CD%BC%D7%AA%BB%BB%B9%A4%BE%DF.rar"],
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
            <a href={`${OLD}${file}`} target="_blank" rel="noreferrer">
              {name}
            </a>
            {extra?.map(([label, href]) => (
              <span key={label}>
                {" "}
                （<Link href={href}>{label}</Link>）
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
