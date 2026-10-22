"use client";

// guide 页「常见问题」侧栏 + 遮罩弹窗（2026-10-21 张老师需求）
// 内容移植自旧版首页右下角常见问题（saolei.net-2008/asp/Help/*.asp，2007-12 张砷镓原作）：
//   4 条弹窗（Why/Grow/Ranking/Video）原文搬运 + 3 条直链（分辨率 283 / QQ群 1187 /
//   术语介绍 /page/help/word——2026-10-22 术语内容变长弹窗出滚动条，改独立页承载，
//   页面本身带 .term 黄高亮，弹窗版数据已删）
// 布局：guide 页 two_columns 右栏；≤880 随站内规则单列化落到主栏下方
// 关闭方式：Esc / 点遮罩 / 右下按钮（与旧版 Window 弹窗行为一致）

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// 弹窗正文（旧版原文，仅做 HTML 化；term=术语高亮 note=注意事项，样式在 globals.css）
// wide=1.5 倍宽弹窗（2026-10-21 张老师需求：「怎样加入排行」内容多，500→750）
type FaqItem = { title: string; body: React.ReactNode; wide?: boolean };

const RANKING_LINKS = (
  <>
    请先下载 Minesweeper Arbiter。本软件为英文版，中文说明请见
    《<Link href="/bbs/11038">Minesweeper Arbiter使用教程(一)</Link>》。
    下载后解压缩并进入游戏，如果遇到问题，<Link href="/bbs">请到论坛提问</Link>。
  </>
);

const FAQ_ITEMS: Record<string, FaqItem> = {
  why: {
    title: "我们为什么玩扫雷",
    body: (
      <>
        1、任何一台电脑上只要有Windows就有扫雷，因此扫雷拥有世界上最大的玩家群体。
        <br />
        2、扫雷不用花钱也可以玩
        <br />
        3、扫雷不用上网也可以玩
        <br />
        4、扫雷不用电脑配置很高也可以玩
        <br />
        5、扫雷可以锻炼你的逻辑思维能力、抽象思维能力、想象力、判断力、反应速度。
        <br />
        6、从扫雷中可以悟到很多哲理
        <br />
        7、游戏周期短，想玩就玩不想玩就不玩，只要一两分钟空闲就可以玩。
        <br />
        8、扫雷成绩是永恒的，等网络游戏都关门了，你的成绩仍然能被世界上的雷友所承认。
      </>
    ),
  },
  grow: {
    title: "怎样提高扫雷水平",
    body: (
      <>
        1、选择适合自己的鼠标、鼠标垫
        <br />
        2、选择适合自己的鼠标速度和屏幕分辨率
        <br />
        3、多看网站上的教程，提升思路
        <br />
        4、多看比自己厉害的录像，找到差距
        <br />
        5、多多练习，将学到看到的变成自己的
      </>
    ),
  },
  ranking: {
    title: "怎样加入雷界排行榜",
    wide: true,
    body: (
      <>
        <b className="term">下载并安装扫雷软件</b>
        <br />　{RANKING_LINKS}
        <br />
        <b className="term">设置录像标识文字</b>
        <br />
        　进入游戏后按 <kbd>F5</kbd>，可进入设置界面。
        <br />
        　在 Show Player Identification Text 选项下面的输入框中设置录像标识文字。
        <br />
        <b className="note">　录像标识文字只能使用英文</b>
        ，推荐使用姓名拼音附加地区拼音，例如：Wang Wei (Shan Xi)。
        <br />
        　如果您注册时不慎填错了录像标识文字，可与管理员联系进行更改。
        <br />
        　如果您上传了成绩后想更改录像标识文字，必须放弃已有的成绩。
        <br />
        <b className="term">保存扫雷录像</b>
        <br />
        　每次突破纪录后软件会将录像自动保存在软件目录下。
        <br />
        <b className="term">查看录像数据</b>
        <br />
        　在播放录像时，或完成游戏后，游戏主界面旁边的统计窗口会显示录像的各项数据。
        <br />
        　其中最重要的是 <b className="term">3BV</b> 和 <b className="term">Time</b>
        ，这是上传录像时必须填写的数据。
        <br />
        <b className="term">上传扫雷录像</b>
        <br />
        　登陆中国扫雷网，点击导航栏的上传录像。
        <br />
        　选择录像级别，输入完成游戏的时间(精确到2位小数)和3BV值，选择录像文件，开始上传。
        <br />
        　经审核后的录像将计入个人扫雷成绩，系统将自动取各级别的最短时间和最高3BV/S作为纪录保存。
        <br />
        <b className="note">
          　当初/中/高三个级别的时间和3BV/S成绩都有纪录后，系统自动将您纳入国内扫雷排行。
        </b>
      </>
    ),
  },
  video: {
    title: "怎么看录像",
    body: (
      <>
        　要观看avf录像，请先下载 Minesweeper Arbiter 0.52.2。
        <br />
        　要观看mvf录像，请先下载 Minesweeper Clone 0.97 并安装。
        <br />
        　安装完后运行进入游戏，如果遇到问题，<Link href="/bbs">请到论坛提问</Link>。
        <br />
        　打开网站上任何一个录像，点击<b className="term">“保存录像”</b>，将录像保存到桌面上。
        <br />
        　双击保存下来的录像文件，选择打开方式。
        <br />
        　mvf录像浏览到 Clone 的安装目录，选择 Minesweeper Clone.exe。
        <br />
        　avf录像浏览到 Arbiter 的所在目录，选择 ms_arbiter.exe。
        <br />
        　选择“始终使用选择的程序打开这种文件”。
        <br />
        　打开网站上任何一个录像，点击<b className="term">“打开录像”</b>，选择“始终打开”。
        <br />
        　好了，现在你可以选择“打开录像”来直接播放，也可以选择“保存录像”将其下载。
      </>
    ),
  },
};

// 侧栏条目：key 弹窗 | link 站内直链 | bbsId 跳论坛帖（旧版同款直链）
const FAQ_LINKS: { key: string; label: string; bbsId?: number; link?: string }[] = [
  { key: "why", label: "我们为什么玩扫雷？" },
  { key: "grow", label: "怎样提高我的扫雷水平？" },
  { key: "ranking", label: "怎样加入雷界排行榜？" },
  { key: "word", label: "3BV、NF等术语是什么意思？", link: "/page/help/word" },
  { key: "video", label: "如何观看本网站的录像？" },
  { key: "bbs-283", label: "怎样调整屏幕分辨率？", bbsId: 283 },
  { key: "bbs-1187", label: "怎样加入扫雷网QQ群？", bbsId: 1187 },
];

export default function GuideFaq() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const item = openKey ? FAQ_ITEMS[openKey] : null;

  const close = useCallback(() => setOpenKey(null), []);

  // Esc 关闭（与旧版 Window 弹窗一致）
  useEffect(() => {
    if (!openKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openKey, close]);

  return (
    <div id="faq_side" className="box text">
      <h2>常见问题</h2>
      <ul className="faq_list">
        {FAQ_LINKS.map(({ key, label, bbsId, link }) => (
          <li key={key}>
            {link ? (
              <Link href={link}>{label}</Link>
            ) : bbsId ? (
              <Link href={`/bbs/${bbsId}`}>{label}</Link>
            ) : (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setOpenKey(key);
                }}
              >
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
      <p className="faq_more">
        还有其他问题？<Link href="/bbs">到论坛提问</Link>
      </p>

      {item && (
        <div
          className="faq_mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            className={"faq_dialog" + (item.wide ? " wide" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={item.title}
          >
            <header>
              <h3>{item.title}</h3>
              <span className="faq_close" onClick={close} role="button" aria-label="关闭">
                ×
              </span>
            </header>
            <div className="faq_body">{item.body}</div>
            <footer>
              <button type="button" onClick={close}>
                明白了
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
