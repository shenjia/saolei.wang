// 头像 AI 审核（2026-09-24 张老师需求：个人资料页上传头像 + AI 初审 + 人工复核）
//
// 设计原则（沿用 01xue.com/src/lib/ai-moderator.ts 已验证的思路）：
// 1. 永不自动拒绝：AI 只判 pass / review。判 review 一律转人工，由管理员定夺，
//    避免误杀（法规风险内容人工兜底，正常用户不会被机器拒之门外）。
// 2. 不阻塞用户：超时 6 秒，失败/超时一律降级 review 转人工，用户始终拿到「已提交」反馈。
// 3. 可开关：未配置 GLM_API_KEY 或 AVATAR_AI_ENABLED=false → 全部转人工（降级为纯人工队列）。
//
// 模型：glm-4v-flash（视觉，实测 ~0.9s、有免费额度；智谱无 glm-5v，glm-4v-flash 是最快的一档）。
//   审核模型独立于网关配置，用 GLM_VISION_MODEL 覆盖。
//
// 输入格式限制（2026-09-24 实测，重要）：
//   智谱视觉接口只吃 JPEG / PNG（WebP 未验证）；**GIF 与 HEIC 一律 400「图片输入格式/解析错误」**。
//   所以上传链路必须先在客户端用 canvas 归一化成 JPEG，不能直接透传原始文件。
//   另外 1.6MB 的 PNG 要 2.1 秒，逼近超时——归一化到 400px（约 40KB）后耗时降到 ~0.9 秒。

export type AvatarVerdict = "pass" | "review";
export type AvatarCategory = "ok" | "porn" | "politics" | "nonreal";
export type AvatarModerationSource = "ai" | "disabled" | "timeout" | "error";

export interface AvatarModerationResult {
  /** pass = 判定为合格真人照片，可直接生效；review = 拿不准，转人工 */
  verdict: AvatarVerdict;
  category: AvatarCategory;
  /** 中文简短说明，写入 avatar_review.reason，管理后台展示 */
  reason: string;
  /** 调用来源，便于排查：ai / disabled / timeout / error */
  source: AvatarModerationSource;
}

const GLM_API_URL =
  process.env.GLM_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_MODEL = process.env.GLM_VISION_MODEL || "glm-4v-flash";
const GLM_API_KEY = process.env.GLM_API_KEY;
const AI_ENABLED = process.env.AVATAR_AI_ENABLED !== "false"; // 默认启用，显式 false 才关

/** AI 调用超时（毫秒）。归一化后的小图约 1 秒返回，6 秒给足网络抖动余量。 */
const AI_TIMEOUT_MS = 6000;

/** 本站头像审核口径：只收真人照片（2026-09-24 张老师确认） */
const SYSTEM_PROMPT = `你是扫雷网（saolei.wang）的头像审核员。用户上传的图片会作为公开头像展示，站内有未成年人用户，审核从严。

只允许「真实人物照片」作为头像。以下三类必须拦截：
- porn：色情、裸露、性暗示、低俗擦边
- politics：政治敏感（国旗国徽、领导人、政治标语、政治事件、军事）
- nonreal：不是真人照片——卡通/动漫/表情包/纯文字/风景/物品/纯色图案/二次元人物/AI 生成的非真实人脸

规则：
1. 画面中没有清晰可辨的真实人脸，一律判 nonreal
2. 拿不准的一律 review 转人工，不要强行判定
3. 不要返回 reject，只返回 pass 或 review
4. reason 用中文，不超过 30 字

只返回 JSON：{"verdict":"pass"|"review","category":"ok"|"porn"|"politics"|"nonreal","reason":"简短说明"}`;

const CATEGORIES: AvatarCategory[] = ["ok", "porn", "politics", "nonreal"];

function degrade(
  reason: string,
  source: AvatarModerationSource,
  category: AvatarCategory = "ok",
): AvatarModerationResult {
  return { verdict: "review", category, reason, source };
}

/**
 * 审核一张头像图片。
 * @param image 图片二进制（务必是先归一化过的 JPEG，见文件头格式限制说明）
 * @param mime  图片 MIME，默认 image/jpeg
 */
export async function moderateAvatar(
  image: Buffer,
  mime = "image/jpeg",
): Promise<AvatarModerationResult> {
  if (!AI_ENABLED || !GLM_API_KEY) {
    return degrade("AI 审核未启用，转人工", "disabled");
  }

  const dataUrl = `data:${mime};base64,${image.toString("base64")}`;
  const body = {
    model: GLM_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: "审核这张头像。" },
        ],
      },
    ],
    temperature: 0.1, // 审核要稳定，不要发散
    max_tokens: 120, // 只要短 JSON
    // 与 01xue 审核模块一致：显式关思考，否则混合思考模型会先想数十秒，必超时
    thinking: { type: "disabled" },
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
      console.warn(
        `[avatar-moderate] GLM API ${resp.status}: ${errText.slice(0, 200)}`,
      );
      return degrade(`AI 审核失败（HTTP ${resp.status}），转人工`, "error");
    }

    const data = await resp.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";

    // response_format=json_object 下应直接是 JSON；保险起见做容错解析（模型偶尔会用 ```json 包裹）
    let parsed: { verdict?: string; category?: string; reason?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        console.warn(`[avatar-moderate] 无法解析响应: ${text.slice(0, 200)}`);
        return degrade("AI 响应格式异常，转人工", "error");
      }
      parsed = JSON.parse(m[0]);
    }

    const verdict: AvatarVerdict = parsed.verdict === "pass" ? "pass" : "review";
    const rawCat = String(parsed.category ?? "");
    const category: AvatarCategory = (CATEGORIES as string[]).includes(rawCat)
      ? (rawCat as AvatarCategory)
      : "ok";
    const reason =
      String(parsed.reason ?? "").slice(0, 100) ||
      (verdict === "pass" ? "AI 判定为真人照片" : "AI 标记需人工确认");

    // 一致性兜底：模型偶尔给出 verdict=pass 但 category=nonreal 这类矛盾结果，
    // 以「拦截优先」为准——分类不是 ok 就不放行
    if (verdict === "pass" && category !== "ok") {
      return { verdict: "review", category, reason: reason || "AI 结果矛盾，转人工", source: "ai" };
    }

    return { verdict, category, reason, source: "ai" };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    console.warn(
      `[avatar-moderate] ${isTimeout ? "超时" : "调用异常"}:`,
      err instanceof Error ? err.message : err,
    );
    return degrade(isTimeout ? "AI 审核超时，转人工" : "AI 审核异常，转人工", isTimeout ? "timeout" : "error");
  }
}
