// Minesweeper Clone 0.97 常见问题（移植 2008 版 Help/Question.asp）
import Link from "next/link";

export const metadata = { title: "Clone 0.97 常见问题 | 扫雷网" };

const QA: [string, string[]][] = [
  [
    "运行游戏点击鼠标便自动退出",
    ["本游戏要求屏幕颜色为 32 位，进入 控制面板 - 显示 - 设置，将 颜色质量 调整为 最高(32位) 即可。"],
  ],
  [
    "运行游戏后始终最小化",
    [
      "本问题是因为软件最小化状态下在任务栏上右键关闭导致。解决方法有二：",
      "1、打开游戏安装目录下的 minesweeperclone.inf，将 Main X 和 Main Y 都改为 0 保存即可。",
      "2、在任务栏右键点击软件窗口，选择 移动，按上下左右任意一个方向键，点击左键。",
    ],
  ],
  ["完成游戏后无法保存录像", ["打开 Option 菜单，选择 Classic Mode 即可。"]],
  ["重装软件后各项纪录都为 0 无法刷新", ["打开纪录窗口，选择 Reset 即可。"]],
  [
    "重装软件如何保存各种纪录和统计数据",
    ["事先备份游戏安装目录下的 history.inf 和 history-density.inf，重装后拷贝至新安装目录下即可。"],
  ],
  [
    "游戏结束时提示 Run-time error '55' : File already open",
    ["按 F5 键，进入 Auto recording，将 Text for videos 和 Player Name 都设置为英文。"],
  ],
];

export default function CloneFaqPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>Minesweeper Clone 0.97 常见问题</h1>
        {QA.map(([q, answers]) => (
          <div key={q}>
            <h2>{q}</h2>
            {answers.map((a, i) => (
              <p key={i}>{a}</p>
            ))}
          </div>
        ))}
        <hr />
        <Link href="/page/help" className="button active">
          我明白了，多谢指教
        </Link>
      </div>
    </div>
  );
}
