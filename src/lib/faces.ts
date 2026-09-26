// 表情语义编码表（2026-09-26 张老师要求：新版表情不得用纯数字编码，
// 避免表情顺序调整后错配——语义 key 跟着表情走，与面板顺序解耦）
//
// 槽位语义以旧版 QQ 30 槽为准（c1fd3ce 整合定稿）：
//   1呲牙 2受伤(→裂开) 3尴尬 4晕 5无语 6墨镜(→社会社会) 7抠鼻 8发呆 9色 10惊讶
//   11吐 12害羞 13睡 14惊恐 15大哭 16白眼 17偷看(→让我看看) 18疑问 19翻白眼 20咒骂
//   22猪头 23发怒 28强 29胜利 30炸弹
// 21(黑脸)/24(公鸡)/25-26(企鹅)/27(灯泡) 无微信对应，旧 gif 转 PNG 原样占位——
//   这些槽位的「语义」就是旧图本身，key 按图内容命名。
//
// 编码规则：
//   旧版 [face]N[/face]     → /images/face/N.gif    （纯数字，2 万存量帖焊死，永不改）
//   新版 [face]key[/face]   → /images/face-wx/N.png （语义 key，顺序调整只动这里）
//   过渡码 [face]Nn[/face]  → 兼容渲染（仅 7 条站内测试帖，已迁移；编辑器载入时归一化为 key）
// 本文件零依赖：服务端（lib/bbs.ts）与客户端（RichEditor.tsx）共用，不得 import prisma 等。

export interface FaceSlot {
  /** 旧版槽位号 1-30（= 文件名 face/N.gif，冻结不动） */
  slot: number;
  /** 语义 key（新版 [face]key[/face] 存这个；英文短名，稳定不变） */
  key: string;
  /** 中文语义名（面板 title 等展示用） */
  zh: string;
}

/** 30 槽语义表（下标 = slot - 1） */
export const WX_FACES: FaceSlot[] = [
  { slot: 1, key: "grin", zh: "呲牙" },
  { slot: 2, key: "crack", zh: "裂开" },
  { slot: 3, key: "awkward", zh: "尴尬" },
  { slot: 4, key: "dizzy", zh: "晕" },
  { slot: 5, key: "speechless", zh: "无语" },
  { slot: 6, key: "cool", zh: "社会社会" },
  { slot: 7, key: "nosepick", zh: "抠鼻" },
  { slot: 8, key: "daze", zh: "发呆" },
  { slot: 9, key: "lust", zh: "色" },
  { slot: 10, key: "surprise", zh: "惊讶" },
  { slot: 11, key: "puke", zh: "吐" },
  { slot: 12, key: "shy", zh: "害羞" },
  { slot: 13, key: "sleep", zh: "睡" },
  { slot: 14, key: "panic", zh: "惊恐" },
  { slot: 15, key: "cry", zh: "大哭" },
  { slot: 16, key: "eyeroll", zh: "白眼" },
  { slot: 17, key: "peek", zh: "让我看看" },
  { slot: 18, key: "question", zh: "疑问" },
  { slot: 19, key: "sideeye", zh: "翻白眼" },
  { slot: 20, key: "curse", zh: "咒骂" },
  { slot: 21, key: "blackface", zh: "黑脸" },
  { slot: 22, key: "pig", zh: "猪头" },
  { slot: 23, key: "angry", zh: "发怒" },
  { slot: 24, key: "rooster", zh: "公鸡" },
  { slot: 25, key: "penguin", zh: "企鹅" },
  { slot: 26, key: "penguin2", zh: "企鹅2" },
  { slot: 27, key: "bulb", zh: "灯泡" },
  { slot: 28, key: "strong", zh: "强" },
  { slot: 29, key: "victory", zh: "胜利" },
  { slot: 30, key: "bomb", zh: "炸弹" },
];

/** 语义 key → 槽位信息（O(1) 查询；key 唯一，构建期保证） */
export const FACE_BY_KEY: ReadonlyMap<string, FaceSlot> = new Map(
  WX_FACES.map((f) => [f.key, f])
);

/** 旧槽位号 → 语义 key（[face]Nn[/face] 过渡码归一化用） */
export const FACE_KEY_BY_SLOT: ReadonlyMap<number, string> = new Map(
  WX_FACES.map((f) => [f.slot, f.key])
);

/** key 是否合法（渲染白名单） */
export function isFaceKey(k: string): boolean {
  return FACE_BY_KEY.has(k);
}
