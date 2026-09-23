// 404 页（2026-09-24 张老师要求）：雷区摆出「404」像素字 + Monokai 暗色卡片，
// 视觉元素全部复用本站雷区图块（block16x16.png：b0 未翻格 / bm 黑雷格）与 legacy .button 按钮

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "404 页面不存在 | 扫雷网",
};

// 「404」像素字（* = 雷，. = 未翻格），外圈再包一圈未翻格 → 15×7 格
const DIGITS_404 = [
  "*..*.***.*..*",
  "*..*.*.*.*..*",
  "****.*.*.****",
  "...*.*.*....*",
  "...*.***....*",
];

function boardRows(): string[] {
  const width = DIGITS_404[0].length + 2;
  const rows = [".".repeat(width)];
  for (const row of DIGITS_404) rows.push(`.${row}.`);
  rows.push(".".repeat(width));
  return rows;
}

export default function NotFound() {
  return (
    <div id="page" className="two_columns">
      <div className="box" id="not_found_box">
        <div className="nf_board board size16" aria-hidden="true">
          <table cellPadding={0} cellSpacing={0}>
            <tbody>
              {boardRows().map((row, y) => (
                <tr key={y}>
                  {[...row].map((c, x) => (
                    <td key={x} className={c === "*" ? "bm" : "b0"} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h1>踩雷了！</h1>
        <p className="nf_desc">你要找的页面不存在——也许它已经被扫掉了，或者从未布雷。</p>
        <div className="nf_actions">
          <Link href="/" className="button">
            返回首页
          </Link>
          <Link href="/ranking" className="button">
            看看排行榜
          </Link>
        </div>
      </div>
    </div>
  );
}
