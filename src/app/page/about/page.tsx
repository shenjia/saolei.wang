// 关于本站（移植 2008 版 About/Index.asp）
import Link from "next/link";

export const metadata = { title: "关于本站 | 扫雷网" };

export default function AboutPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>关于本站</h1>
        <p>扫雷，一款简单而又复杂的逻辑推理游戏。</p>
        <p>
          说其简单是因为上手容易，原理简单。说其复杂是因为简单的推理可以叠加组合成各种复杂有趣的形状。扫雷就象走迷宫，各有巧妙不同，或箭步如梭，或如履薄冰，或彷徨其中无疾而终。高手和普通玩家的区别就在于他们总是能用相对合理的手法高效率的完成游戏。扫雷是技术与速度紧密结合的游戏，每一次的提高都带来喜悦和反思，去迎接下一次突破。
        </p>
        <p>
          游戏如人生，我们都有过破纪录的兴奋，也有过痛失好局的沮丧。世事如棋，正所谓胜不骄，败不馁，保持良好的心态，或许在游戏之外你还能感悟到更多……
        </p>
        <p>
          本站旨在为国内广大雷友提供一个互相学习的空间，不再孤军奋战，让我们取长补短，不断提高，没有最好，只有更好。需要超越的永远是自己！
        </p>
        <p>
          本站的创意始于 2006 年 10 月，受到了 Damien Moore 所做国际排行的启发，并以雷友 birdy
          所做的国内排行为起点。建站得到了 [M.S]挖金团 家族族长 纯白 的大力协助，在此对以上友人表示真挚的感谢！
        </p>
        <hr />
        <Link href="/page/donate" className="button">
          提供赞助
        </Link>{" "}
        <Link href="/page/history" className="button">
          查看本站更新历史
        </Link>
      </div>
    </div>
  );
}
