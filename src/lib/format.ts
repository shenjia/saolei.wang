// 格式化工具，移植自 2013 版 PHP 的 helpers/Format.php 与 helpers/Time.php
// 本模块保持「纯函数、零副作用」（不碰 prisma），服务端与客户端组件可共用；
// videoScores 2026-09-24 从 lib/queries 迁入，使录像行渲染件能被首页录像版块（客户端）复用。

import { MIN_3BV_FOR_3BVS } from "./config";

/** 录像成绩换算（移植 VideoModel::getScores）：time=real_time(ms)，3bvs=board_3bv×1e6/real_time，
 *  3BV 小于阈值时记负值（渲染层据此显示删除线，表示成绩不被承认） */
export function videoScores(board3bv: number, realTime: number): { time: number; "3bvs": number } {
  const sign = board3bv >= MIN_3BV_FOR_3BVS ? 1 : -1;
  return {
    time: realTime,
    "3bvs": realTime > 0 ? sign * Math.round((board3bv * 1000000) / realTime) : 0,
  };
}

/** 时间成绩：存储为毫秒，显示为秒（2 位小数） */
export function scoreTime(score: number | null | undefined): string {
  if (!score || score <= 0) return "";
  return (score / 1000).toFixed(2);
}

/** 3BV/s 成绩：存储为实际值×1000，显示 3 位小数 */
export function score3bvs(score: number | null | undefined, negative = false): string {
  if (!score || (score <= 0 && !negative)) return "";
  return (score / 1000).toFixed(3);
}

/** 地区榜「综合排行指数」：1 万以上按 xx.x万 显示（精确到一位小数），否则原样输出（2026-10-14 W→万） */
export function areaPower(power: number): string {
  return power >= 10000 ? `${(power / 10000).toFixed(1)}万` : String(power);
}

/** 老 ASP 站入库时做的一次 HTML 转义解码（2026-10-15：修 bbs/5264 评论显示 &gt;.&lt; 字面量）。
 *  旧站把用户输入（如颜文字 >.<、emoji &#10060;、空格 &nbsp;）转义后直接落库，旧站渲染不转义
 *  所以显示正常；新站按文本渲染会再次转义，字面实体就漏出来了。渲染前统一解掉：
 *  · &nbsp; → 不换行空格、&lt;/&gt;/&quot;/&#39; → 原字符
 *  · &amp;#N; / &#N; 数字实体（GBK 时代存不进库的 emoji，库里实测全是 &amp;# 前缀双重形态）
 *  · &amp; 最后解（避免 &amp;gt; 提前展开成 >；旧站语义本就是「&」字符，
 *    文本渲染链路随后会再转义回去，正常显示「&」） */
export function decodeLegacyEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/(?:&amp;|&)#(\d+);/g, (m, d: string) => {
      const cp = parseInt(d, 10);
      // 仅解可显示字符：ASCII 可见区 32-126 + BMP 主体（避开控制区与代理区 55296-57343）
      if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 55295) || (cp >= 57344 && cp <= 65533)) {
        return String.fromCodePoint(cp);
      }
      return m;
    })
    .replace(/&amp;/gi, "&");
}

/** 站内信标题内嵌链接标记（2026-10-15 评论通知）：[url /bbs/123]《标题》[/url]
 *  写入 message.content；纯函数（不引 ubb/Prisma），客户端列表/详情均可解析渲染 */
export const MSG_LINK_RE = /\[url\s+(\/[^\s\[\]]+)\]([^\[\]]*?)\[\/url\]/g;

export interface MsgLinkPart {
  text: string;
  href: string;
}

/** 消息正文分段：链接段（跳文章页）与纯文本段交错
 *  「我回复了你在《xxx》文章中的评论」里点击《xxx》跳 /bbs/N —— 列表页摘要与详情页共用 */
export function parseMessageParts(content: string): Array<MsgLinkPart | string> {
  const out: Array<MsgLinkPart | string> = [];
  let last = 0;
  for (const m of content.matchAll(MSG_LINK_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(content.slice(last, i));
    out.push({ text: m[2], href: m[1] });
    last = i + m[0].length;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}

/** UBB 剥标签纯文本（回帖引用摘要用）：[img]→图、[face]→[表情]、[N]/雷图键→[雷]、
 *  其余 UBB 标签直接剥壳留内容；老 ASP 实体先解（同 ubb() 管线口径） */
export function ubbExcerpt(raw: string, limit: number): string {
  const norm = decodeLegacyEntities(raw.replace(/<br\s*\/?>/gi, "\n"));
  const t = norm
    .replace(/\[img\][^\[\]]*?\[\/img\]/gi, "[图]")
    .replace(/\[face\][^\[\]]*?\[\/face\]/gi, "[表情]")
    .replace(/\[url[^\[\]]*?\]([^\[\]]*?)\[\/url\]/gi, "$1")
    .replace(/\[\/?(?:b|i|u|quote|Title|Sign|Signest)\]/gi, "");
  const plain = t.replace(/\[(?:[0-8]|[ .Q!?*+-X])\]/g, "[雷]");
  return plain.length > limit ? plain.slice(0, limit) + "…" : plain;
}

const SECONDS_PER_DAY = 86400;
const NEVER = 3153600000; // 100 年，即「永远显示绝对时间」

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 绝对日期格式化（移植 PHP date() 的常用占位符）
 *  2026-10-15 补 s（秒）占位符：此前未实现，"H:i:s" 末尾的字面 s 会原样漏出
 *  （录像列表 tooltip「18:08:s」），全站格式串均不含字母 s 作字面量，追加替换无副作用 */
export function formatDate(time: number, format: string): string {
  const d = new Date(time * 1000);
  return format
    .replace("Y", String(d.getFullYear()))
    .replace("n", String(d.getMonth() + 1))
    .replace("m", pad(d.getMonth() + 1))
    .replace("j", String(d.getDate()))
    .replace("d", pad(d.getDate()))
    .replace("H", pad(d.getHours()))
    .replace("i", pad(d.getMinutes()))
    .replace("s", pad(d.getSeconds()));
}

/**
 * 相对时间（移植 Time::opposite）
 * @param time   Unix 秒
 * @param max    超过该秒数则显示绝对时间
 * @param format 绝对时间格式
 */
export function timeOpposite(
  time: number,
  max: number = SECONDS_PER_DAY,
  format = "Y年n月j日 H:i"
): string {
  let now = Math.floor(Date.now() / 1000);
  let t = time;

  if (Math.abs(t - now) > max) return formatDate(t, format);

  let direction = "前";
  if (t > now) {
    [now, t] = [t, now];
    direction = "后";
  }

  const minDis = Math.floor((now - t) / 60);
  const horDis = Math.floor((now - t) / 3600);
  const dayDis = Math.floor((now - t) / 86400);
  const wekDis = Math.floor(dayDis / 7);

  const nowDate = new Date(now * 1000);
  const tDate = new Date(t * 1000);
  let monDis =
    nowDate.getFullYear() * 12 + nowDate.getMonth() - (tDate.getFullYear() * 12 + tDate.getMonth());
  const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate();
  if (dayDis < daysInMonth) monDis = 0;

  let yerDis = nowDate.getFullYear() - tDate.getFullYear();
  let thisYearDays = 365;
  const y = nowDate.getFullYear();
  if ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) thisYearDays++;
  if (dayDis < thisYearDays) yerDis = 0;

  if (yerDis) return yerDis + "年" + direction;
  if (monDis) return monDis + "月" + direction;
  if (wekDis) return wekDis + "周" + direction;
  if (dayDis) return dayDis + "天" + direction;
  if (horDis) return horDis + "小时" + direction;
  if (minDis) return minDis + "分钟" + direction;
  return "刚刚";
}

export const TIME_NEVER = NEVER;
/** 一年（秒）：动态列表日期口径——一年内显示相对时间，超过一年显示日期（2026-09-23 张老师要求） */
export const TIME_YEAR = 365 * SECONDS_PER_DAY;
/** 一个月（30 天，秒）：评论区日期口径——一个月内相对时间，超过则显示日期（2026-10-13 张老师要求） */
export const TIME_MONTH = 30 * SECONDS_PER_DAY;

/** 距今是否不足一年（用于日期配色：一年内偏亮，一年以上偏暗，2026-09-24 张老师要求） */
export function isRecent(time: number): boolean {
  return Math.abs(Math.floor(Date.now() / 1000) - time) < TIME_YEAR;
}
