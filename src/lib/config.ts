// 扫雷网领域配置，移植自 2013 版 PHP 的 *Config.php

export const LEVELS = ["beg", "int", "exp", "sum"] as const;
export type Level = (typeof LEVELS)[number];

export const ORDERS = ["time", "3bvs"] as const;
export type Order = (typeof ORDERS)[number];

// time 升序（越小越好），3bvs 降序（越大越好）
export const ORDER_DIRECTION: Record<Order, "asc" | "desc"> = {
  time: "asc",
  "3bvs": "desc",
};

export const LEVEL_NAMES: Record<Level | "all", string> = {
  all: "全部",
  beg: "初级",
  int: "中级",
  exp: "高级",
  sum: "总计",
};

export const ORDER_NAMES: Record<Order, string> = {
  time: "时间记录",
  "3bvs": "3BV/s记录",
};

export const RANKING_PAGESIZE = 20;
export const VIDEO_PAGESIZE = 20;
export const HOME_TOP_NUMBER = 10;
export const HOME_NEWBIE_NUMBER = 5;
export const HOME_NEWS_NUMBER = 30;

// ---------- 评论（移植 CommentConfig） ----------
export const COMMENT_TOP_NUMBER = 5;
export const COMMENT_PAGESIZE = 15;
export const COMMENT_CONTENT_LIMIT = 100;
export const COMMENT_STATUS = { NORMAL: 0, DELETED: -1 } as const;

// 动态「加载更多」每页条数（移植 NewsConfig::PAGESIZE）
export const NEWS_PAGESIZE = 20;
// 用户主页动态初始条数（移植 UserConfig::NEWS_NUMBER）
export const USER_NEWS_NUMBER = 5;

// ---------- 军衔（移植 TitleConfig） ----------

export const TITLES = [
  "大元帅", "元帅", "大将", "上将", "中将", "少将",
  "大校", "上校", "中校", "少校",
  "上尉", "中尉", "少尉",
  "上士", "中士", "下士",
  "上等兵", "列兵",
] as const;

export const TITLE_CLASSES: Record<string, string> = {
  大元帅: "grand",
  元帅: "marshal",
  大将: "general", 上将: "general", 中将: "general", 少将: "general",
  大校: "colonel", 上校: "colonel", 中校: "colonel", 少校: "colonel",
  上尉: "captain", 中尉: "captain", 少尉: "captain",
  上士: "sergeant", 中士: "sergeant", 下士: "sergeant",
  上等兵: "private", 列兵: "private",
};

// 军衔评定使用 总计时间（sum_time）
export const TITLE_LEVEL: Level = "sum";
export const TITLE_ORDER: Order = "time";

// 固定编制军衔（前 6 个按人数，其余按比例，移植 TitleConfig）
export const FIXED_TITLES = ["大元帅", "元帅", "大将", "上将", "中将", "少将"] as const;

export const TITLE_DISTRIBUTION: Record<string, number> = {
  大元帅: 1,
  元帅: 10,
  大将: 30,
  上将: 60,
  中将: 100,
  少将: 150,
  大校: 0.03,
  上校: 0.07,
  中校: 0.12,
  少校: 0.18,
  上尉: 0.25,
  中尉: 0.33,
  少尉: 0.42,
  上士: 0.52,
  中士: 0.63,
  下士: 0.75,
  上等兵: 0.88,
  列兵: 1.0,
};

// ---------- 评级（移植 GradeConfig） ----------

export const GRADES = ["SSS", "SS", "S", "A", "B", "C", "D", "E", "F"] as const;

export const GRADE_PERCENTS = [100, 90, 80, 70, 60, 50, 35, 15, 5];

// ---------- 录像（移植 VideoConfig） ----------

export const VIDEO_LEVELS = ["beg", "int", "exp"] as const;
export type VideoLevel = (typeof VIDEO_LEVELS)[number];

export const VIDEO_STATUS = {
  BANNED: 0,
  NORMAL: 10,
  REVIEWED: 20,
} as const;

export const VIDEO_STATUS_NAMES: Record<number, string> = {
  0: "已屏蔽",
  10: "待审核",
  20: "已通过",
};

// 3BV 小于该值时 3BV/s 成绩不被承认（显示删除线）
export const MIN_3BV_FOR_3BVS = 4;

// 棋盘尺寸（移植 board.js）
export const BOARD_SIZE: Record<VideoLevel, { x: number; y: number }> = {
  beg: { x: 8, y: 8 },
  int: { x: 16, y: 16 },
  exp: { x: 30, y: 16 },
};

// ---------- 用户角色（移植 UserConfig::ROLE_*） ----------
export const USER_ROLE = {
  PLAYER: 0,
  MANAGER: 10,
  ADMINISTRATOR: 100,
} as const;

export function isManager(role: number): boolean {
  return role === USER_ROLE.MANAGER || role === USER_ROLE.ADMINISTRATOR;
}

// 上传录像各级别最小 3BV（移植 VideoConfig::$level_min_3bv）
export const LEVEL_MIN_3BV: Record<VideoLevel, number> = { beg: 2, int: 30, exp: 100 };

// ---------- 新闻（移植 NewsConfig） ----------

export const NEWS_TYPE = {
  NOTICE: 0,
  NEWBIE: 10,
  PERSON_RECORD: 20,
  AREA_RECORD: 21,
  NATION_RECORD: 22,
  VIDEO: 30,
  ARTICLE: 40,
} as const;
