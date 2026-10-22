// 扫雷术语介绍（移植 2008 版 Help/Word.asp）
// 2026-10-22：guide 页 FAQ 术语弹窗因内容变长出滚动条，改为独立页承载（FAQ 入口改跳本页，
// 见 GuideFaq.tsx）。每条术语名高亮展示（弹窗同款 .term 黄），desc 内可嵌 {t:"..."}
// 片段做次级高亮（如 Ce/Cl）；正文色与弹窗口径一致取 .text p 的 #939387。
import Link from "next/link";

export const metadata = { title: "扫雷术语介绍" };

type Seg = string | { t: string }; // {t} = 黄色高亮片段
const TERMS: [string, Seg[]][] = [
  ["3BV: Bechtel's Board Benchmark Value", ["每局将所有非雷的方块点开所需最少左键点击数，目前普遍用来评估局面难易程度的数据。"]],
  [
    "3BV/s: 3BV per second [ 3BV / (Time - 1) ]",
    ["一局内平均每秒钟完成的 ", { t: "3BV" }, " 值，是目前普遍用来评估玩家扫雷速度的数据。"],
  ],
  ["UPK: Unfair Prior Knowledge", ["可重新开始同一局的游戏模式，本模式保存的录像不能参与排名。"]],
  [
    "IOE: Index of Efficiency [ 3BV / Total Clicks ]",
    ["3BV 与实际点击数的比率，是目前普遍用来评估玩家操作效率的数据。"],
  ],
  [
    "IOS: Index of Speed [ log(Time-1) / log(3BV) ]",
    ["时间的倒数与 3BV 的倒数之比率，与 3BV/s 作用相当。"],
  ],
  [
    "RQP: Rapport Qualité Prix [ Time / (3BV/s) ]",
    ["时间与 3BV/s 的比率，因加入了时间因素，比 3BV/s 更能说明扫雷速度。"],
  ],
  [
    "QG: Quality Grade [ Time^1.7 / 已完成3BV ]",
    ["质量分，综合用时与完成 3BV 的数据，越小越好，是计算 STNB 的中间量。"],
  ],
  [
    "STNB [ 系数(初级36、中级162、高级435) / QG × (已完成3BV/3BV)^0.5 ]",
    ["综合评分，用来衡量一局游戏（包括失败的游戏尸体）所体现出的竞速水平，现已取代 RQP，越大越好。"],
  ],
  [
    "ThrP: Throughput [ 已完成3BV / Ce ]",
    ["吞吐效率，已完成 3BV 与有效点击数的比率。", { t: "Ce" }, " 为真正开出新格或完成 3BV 的有效点击。"],
  ],
  [
    "Corr: Correctness [ Ce / Cl ]",
    ["准确率，有效点击数 ", { t: "Ce" }, " 与总点击数 ", { t: "Cl" }, " 的比率。", { t: "Cl" }, " 为左键、右键、双击的总点击次数，用来衡量操作的精准程度。"],
  ],
  ["NF: No Flag", ["一种仅用左键点击完成游戏，不标雷的玩法。"]],
  ["MB: Miss Block", ["整个局面都完成，但有一个方块因忽视而没有点开的情况。"]],
  ["LC: Lose on the last click", ["打开最后一个方格时不幸踩雷。"]],
  ["Sum:", ["初级、中级、高级成绩相加而得出的总成绩。"]],
  ["Sub:", ["小于某数值，比如高级 Sub50 就说明高级成绩 < 50。"]],
  ["Sup:", ["大于某数值，比如高级 3BV/S Sup4 就说明高级 3BV/S > 4。"]],
];

export default function WordPage() {
  return (
    <div id="page" className="main">
      <div className="box text word_terms">
        <h1>扫雷术语介绍</h1>
        {TERMS.map(([term, segs]) => (
          <p key={term}>
            <b className="term">{term}</b>
            <br />
            {segs.map((seg, i) =>
              typeof seg === "string" ? (
                <span key={i}>{seg}</span>
              ) : (
                <b className="term" key={i}>
                  {seg.t}
                </b>
              )
            )}
          </p>
        ))}
        <hr />
        <Link href="/page/guide" className="button active">
          我明白了，多谢指教
        </Link>
      </div>
    </div>
  );
}
