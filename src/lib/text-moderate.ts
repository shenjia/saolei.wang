// UGC 文本 AI 审核（2026-10-13 张老师需求：敏感词前置 + AI 后置）
//
// 定位：这是「后置」审核——内容已经发表，AI 只在判定可疑时把它转成「待审」（不公开），
//       交管理员复核。与前置的词库过滤（sensitive.ts，命中即拒绝发表）是两道独立闸门。
//
// 设计原则（沿用 01xue ai-moderator 与本站 avatar-moderate 已验证的思路）：
// 1. 永不自动删除：AI 只判 pass / review。review 转人工，绝不代替管理员做删除决定。
// 2. 失败一律放行：超时/报错/未配置 → verdict=pass（内容保持公开）。异步链路里
//    AI 故障若改成「转待审」，会导致全站内容被集体隐藏，代价远大于漏审。故障只记告警。
// 3. 可开关：未配置 GLM_API_KEY 或 TEXT_AI_ENABLED=false → 恒 pass（等同未启用，纯词库过滤）。
//
// 模型：glm-4-flash（2026-10-13 实测该 key 下免费可用、~0.5s 返回；glm-4-air 余额不足）。
//   可用 GLM_TEXT_MODEL 覆盖。该模型不做思考链，故不传 thinking 参数。

export type TextVerdict = "pass" | "review";
export type TextCategory = "ok" | "ad" | "porn" | "politics" | "abuse" | "illegal";
export type TextModerationSource = "ai" | "disabled" | "timeout" | "error";

export interface TextModerationResult {
  /** pass = 放行（保持公开）；review = 拿不准，转人工复核（置为待审） */
  verdict: TextVerdict;
  category: TextCategory;
  /** 中文简短说明，写入服务端日志、后台展示 */
  reason: string;
  /** 调用来源，便于排查：ai / disabled / timeout / error */
  source: TextModerationSource;
}

const GLM_API_URL =
  process.env.GLM_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_MODEL = process.env.GLM_TEXT_MODEL || "glm-4-flash";
const GLM_API_KEY = process.env.GLM_API_KEY;
const AI_ENABLED = process.env.TEXT_AI_ENABLED !== "false"; // 默认启用，显式 false 才关

/** AI 调用超时（毫秒）。后置异步链路不在用户等待路径上，给足余量。 */
const AI_TIMEOUT_MS = 8000;

/** 送审文本上限（评论 100 字、回复/主题上限 5000 字；截断只为控 token，不影响判定） */
const MAX_INPUT = 1500;

const SYSTEM_PROMPT = `你是扫雷网（saolei.wang）的内容审核员。站内是扫雷游戏社区，含未成年用户，审核从严。
玩家会发布论坛主题、回帖与录像评论。请判定这段内容是否需要人工复核。

判为 review 的类别（内容必须明确属于以下之一才判）：
- ad：广告推广（拉群带货、代练/外挂/刷成绩、私服、留微信QQ等联系方式引流）
- porn：色情、低俗、性暗示
- politics：真实政治议题（国家、政府、政党、领导人、政治事件、分裂国家言论）
- abuse：辱骂攻击、人身威胁、地域歧视、人肉
- illegal：赌博、毒品、诈骗、传销等违法内容

以下一律 pass，不得误判：
- 扫雷技术、成绩、比赛、聚会等正常讨论，以及提问、求助、闲聊
- 对游戏规则、排行榜、版本更新、军衔体系的吐槽与批评
- 对本站运营、官方活动、管理团队的意见与批评——此处「官方」「政策」「改版」指的是扫雷网站方，与政治无关
- 输局后的抱怨、负面情绪、轻度口头禅

规则：
1. 只有能明确归入上述五个类别之一时才判 review，否则一律 pass
2. politics 仅指现实政治（国家、政府、政党、领导人、政治事件、分裂国家言论）；谈游戏与网站运营不算
3. 只能返回 pass 或 review，不要返回其他值
4. reason 用中文，不超过 30 字

只返回 JSON：{"verdict":"pass"|"review","category":"ok"|"ad"|"porn"|"politics"|"abuse"|"illegal","reason":"简短说明"}`;

const CATEGORIES: TextCategory[] = ["ok", "ad", "porn", "politics", "abuse", "illegal"];

function degrade(reason: string, source: TextModerationSource, category: TextCategory = "ok"): TextModerationResult {
  return { verdict: "pass", category, reason, source };
}

/**
 * 审核一段 UGC 文本。
 * @param text 待审文本（标题+正文可拼接后传入）
 */
export async function moderateText(text: string): Promise<TextModerationResult> {
  if (!AI_ENABLED || !GLM_API_KEY) {
    return degrade("AI 审核未启用", "disabled");
  }
  const input = (text ?? "").trim().slice(0, MAX_INPUT);
  if (!input) return degrade("内容为空", "disabled");

  const body = {
    model: GLM_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    temperature: 0.1, // 审核要稳定，不要发散
    max_tokens: 120, // 只要短 JSON
    response_format: { type: "json_object" as const },
  };

  try {
    const resp = await fetch(GLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[text-moderate] GLM API ${resp.status}: ${errText.slice(0, 200)}`);
      return degrade(`AI 审核失败（HTTP ${resp.status}）`, "error");
    }

    const data = await resp.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";

    // response_format=json_object 下应直接是 JSON；保险起见做容错解析（模型偶尔会用 ```json 包裹）
    let parsed: { verdict?: string; category?: string; reason?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        console.warn(`[text-moderate] 无法解析响应: ${raw.slice(0, 200)}`);
        return degrade("AI 响应格式异常", "error");
      }
      parsed = JSON.parse(m[0]);
    }

    const verdict: TextVerdict = parsed.verdict === "review" ? "review" : "pass";
    const rawCat = String(parsed.category ?? "");
    const category: TextCategory = (CATEGORIES as string[]).includes(rawCat)
      ? (rawCat as TextCategory)
      : "ok";
    const reason =
      String(parsed.reason ?? "").slice(0, 100) ||
      (verdict === "pass" ? "AI 判定正常" : "AI 标记需人工确认");

    // 一致性兜底①：模型偶尔给出 verdict=pass 但 category≠ok 这类矛盾结果，以「拦截优先」为准
    if (verdict === "pass" && category !== "ok") {
      return { verdict: "review", category, reason: reason || "AI 结果矛盾，转人工", source: "ai" };
    }
    // 一致性兜底②：verdict=review 但类别是 ok——模型并没找到任何违规类别，
    // 只是保守起见给了 review（实测会误伤「排行榜刷新慢」这类正常反馈）。既然未归类，按放行处理。
    if (verdict === "review" && category === "ok") {
      return { verdict: "pass", category: "ok", reason: reason || "AI 未归类到违规类别", source: "ai" };
    }

    return { verdict, category, reason, source: "ai" };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    console.warn(
      `[text-moderate] ${isTimeout ? "超时" : "调用异常"}:`,
      err instanceof Error ? err.message : err,
    );
    return degrade(isTimeout ? "AI 审核超时" : "AI 审核异常", isTimeout ? "timeout" : "error");
  }
}

/** 文本审核是否启用（未配置 key / 显式关闭时为 false） */
export function textModerationEnabled(): boolean {
  return AI_ENABLED && !!GLM_API_KEY;
}
