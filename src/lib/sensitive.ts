// 敏感词过滤引擎（2026-10-13 张老师需求）
//
// 用途：论坛主题（标题+正文）/回复、录像评论、纪事、个人资料、中文名、
//       录像签名、站内信、每日一星评语等 UGC 写库前先过一遍，命中即拒绝（不落库）。
//
// 拦截口径（2026-10-27 张老师定）：只拦「涉政涉黄 + 人身攻击 + 违法」，
//   明确不拦广告——拉群带货、代练外挂、留微信QQ、私服等一律放行。
//   后置 AI 审核（text-moderate.ts）同口径：判 ad 也放行。
//
// 设计要点：
//   1. 纯本地、零依赖、零网络：归一化 + Trie 前缀树扫描，单次判定在微秒级。
//   2. 抗绕写：匹配前统一归一化（全角→半角、英文小写、去空白、去常见干扰符），
//      「微 信」「微*信」「ＷｅＣｈａｔ」都会归一到「wechat」再匹配。
//   3. 不回显命中词：对外只报类别（广告推广/不当言论/低俗内容/违规内容），
//      避免把词库内容透给用户、教人绕写。命中词只在服务端日志里出现。
//   4. 词库与引擎分离：词表在 sensitive-words.ts，本文件只管匹配逻辑。
//
// 未做（如需再加）：
//   - 简繁归一（繁体「賭博」暂匹配不到简体词），需完整繁简映射表，当前未引入。
//   - 形近字/同音字替换（「威信」这类已按同音变体手工补进词库，其余靠词库增量覆盖）。

import { SENSITIVE_WORDS } from "./sensitive-words";

// 2026-10-27 张老师定：前置词库不再拦广告（拉群带货、代练外挂、留微信QQ 一律放行），
// 只留「涉政涉黄 + 人身攻击 + 违法」三类。故类型里已无 "ad"——想恢复广告拦截需先改类型，
// 属于口径变更，必先与维护者确认。
export type SensitiveCategory = "abuse" | "porn" | "illegal";

/** 类别 → 对外提示名（回给用户，粒度粗，不暴露具体词） */
export const SENSITIVE_CATEGORY_NAMES: Record<SensitiveCategory, string> = {
  abuse: "不当言论",
  porn: "低俗内容",
  illegal: "违规内容",
};

export interface SensitiveResult {
  /** true = 通过（未命中）；false = 命中敏感词，禁止发布 */
  ok: boolean;
  /** 命中的类别（去重） */
  categories: SensitiveCategory[];
  /** 命中的词（归一化形式，仅供服务端日志排查，禁止回给前端） */
  words: string[];
}

// ---------- 归一化 ----------

// 干扰符：绕写常用的插入符号 + 各类空白。去掉后「微*信」「微 信」「微-信」归一为「微信」。
// 刻意不含数字/字母，避免把无关内容粘连。
const NOISE_RE = /[\s\u00a0\u3000*#\-_.·•~^|｜/\\,，、+=;；:：!'"“”‘’`()（）\[\]【】<>《》]/g;

/**
 * 归一化：全角→半角 → 英文小写 → 去干扰符与空白。
 * 词库入库时也会走同一套归一化，保证两侧同口径。
 */
export function normalize(text: string): string {
  return text
    // 全角 ASCII（含全角数字/字母/标点）→ 半角
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(NOISE_RE, "");
}

// ---------- Trie ----------

interface TrieNode {
  children: Map<string, TrieNode>;
  /** 若本节点是一个词的结尾，记录该词归属的类别 */
  cats?: SensitiveCategory[];
}

function newNode(): TrieNode {
  return { children: new Map() };
}

/** 构建词库 Trie（模块加载时构建一次，常驻内存） */
function buildTrie(): { root: TrieNode; maxLen: number } {
  const root = newNode();
  let maxLen = 0;
  for (const [cat, list] of Object.entries(SENSITIVE_WORDS) as [SensitiveCategory, string[]][]) {
    for (const raw of list) {
      const word = normalize(raw);
      if (!word) continue;
      maxLen = Math.max(maxLen, word.length);
      let node = root;
      for (const ch of word) {
        let next = node.children.get(ch);
        if (!next) {
          next = newNode();
          node.children.set(ch, next);
        }
        node = next;
      }
      if (node.cats) {
        if (!node.cats.includes(cat)) node.cats.push(cat);
      } else {
        node.cats = [cat];
      }
    }
  }
  return { root, maxLen };
}

const { root: TRIE_ROOT, maxLen: TRIE_MAX_LEN } = buildTrie();

// ---------- 对外 API ----------

/**
 * 检查单段文本。
 * @param text 原始文本（标题/正文/评论），内部会自行归一化
 */
export function checkSensitive(text: string | null | undefined): SensitiveResult {
  if (!text) return { ok: true, categories: [], words: [] };
  const norm = normalize(text);
  if (!norm) return { ok: true, categories: [], words: [] };

  const cats = new Set<SensitiveCategory>();
  const words = new Set<string>();
  const n = norm.length;

  // 从每个起点沿 Trie 走，最多走 TRIE_MAX_LEN 步（理论 O(n·maxLen)，maxLen≤8，实测可忽略）
  for (let i = 0; i < n; i++) {
    let node = TRIE_ROOT;
    const limit = Math.min(n, i + TRIE_MAX_LEN);
    for (let j = i; j < limit; j++) {
      const next = node.children.get(norm[j]);
      if (!next) break;
      node = next;
      if (node.cats) {
        words.add(norm.slice(i, j + 1));
        for (const c of node.cats) cats.add(c);
      }
    }
  }

  return { ok: words.size === 0, categories: [...cats], words: [...words] };
}

/**
 * 检查多段文本（如发主题时的标题 + 正文），任一命中即视为不通过。
 */
export function checkSensitiveAll(
  texts: Array<string | null | undefined>,
): SensitiveResult {
  const cats = new Set<SensitiveCategory>();
  const words = new Set<string>();
  for (const t of texts) {
    const r = checkSensitive(t);
    for (const c of r.categories) cats.add(c);
    for (const w of r.words) words.add(w);
  }
  return { ok: words.size === 0, categories: [...cats], words: [...words] };
}

/**
 * 命中时给用户的提示文案（不含具体词）。
 * action 按入口换成「发布 / 保存 / 注册 / 上传 / 发送」，默认「发布」。
 */
export function sensitiveRejectMessage(result: SensitiveResult, action = "发布"): string {
  const names = result.categories.map((c) => SENSITIVE_CATEGORY_NAMES[c]);
  return names.length
    ? `内容包含${names.join("、")}信息，无法${action}，请修改后重试`
    : `内容包含敏感信息，无法${action}，请修改后重试`;
}

/**
 * 命中日志（仅供服务端排查：哪个用户、哪类词命中）。
 * 命中词只在服务端日志里出现，禁止回给前端。
 */
export function logSensitiveHit(
  scope: string,
  uid: number,
  result: SensitiveResult,
): void {
  if (result.ok) return;
  console.warn(
    `[sensitive] ${scope} uid=${uid} cats=${result.categories.join(",")} words=${result.words.join(",")}`,
  );
}
