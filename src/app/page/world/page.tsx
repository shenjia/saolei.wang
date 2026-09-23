// 世界 TOP10 + 加入世界排行说明（移植 2008 版 Ranking/Top10_World.asp + Top10_World_Help.asp）
// 原站为手工维护的静态数据（更新于 2021.5.25）

export const metadata = { title: "世界排行 | 扫雷网" };

const TOP10: [number, string, string, string, string, number][] = [
  [1, "Ze-En Ju", "0.49", "7.30", "28.84", 37],
  [2, "Kamil Muranski", "0.49", "7.03", "31.13", 39],
  [3, "Wei-Jia Guo", "0.54", "7.51", "32.02", 41],
  [4, "Xian-Yao Zhang", "0.65", "8.33", "32.62", 42],
  [5, "Dan Zhou", "0.54", "9.19", "31.90", 42],
  [6, "Mao Igarashi", "0.58", "9.06", "32.59", 43],
  [7, "Ian Fraser", "0.60", "9.45", "32.95", 43],
  [8, "Yao-Yu Zhu", "0.75", "8.36", "33.98", 44],
  [9, "Pavel Mishin", "0.76", "8.41", "34.15", 44],
  [10, "Yu Suzuki", "0.74", "9.77", "33.27", 44],
];

export default function WorldPage() {
  return (
    <div id="page" className="main">
      <div className="box">
        <h1>世界 TOP10</h1>
        <table cellPadding={0} cellSpacing={0} className="table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Name</th>
              <th>Beg</th>
              <th>Int</th>
              <th>Exp</th>
              <th>Sum</th>
            </tr>
          </thead>
          <tbody>
            {TOP10.map(([rank, name, beg, int, exp, sum]) => (
              <tr key={rank}>
                <td>No. {rank}</td>
                <td>{name}</td>
                <td>{beg}</td>
                <td>{int}</td>
                <td>{exp}</td>
                <td>{sum}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ marginTop: 8 }}>
          <a href="http://www.minesweeper.info" target="_blank" rel="noreferrer">
            点击查看完整世界排行
          </a>
          　更新时间：2021.5.25
        </p>
      </div>
      <div className="box text">
        <h1>Damien 的世界排行（minesweeper.info）</h1>
        <p>
          本排行由前世界第一的 Damien Moore
          建立，是目前全球扫雷玩家公认最为权威的世界排行。
        </p>
        <h2>加入世界排行的流程</h2>
        <p>
          首先到 minesweeper.info 注册账号。登录后在欢迎页提交自己的雷网 ID
          即可自动同步雷网的非 NF 纪录。此外还可以通过上传页直接提交录像。
        </p>
      </div>
    </div>
  );
}
