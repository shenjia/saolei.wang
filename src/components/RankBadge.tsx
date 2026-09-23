// 18 级军衔徽章（原创矢量，设计稿 design/rank-badges.html 定稿）
// 全部图形为自绘盾形/五角星/V拐/地雷/月桂，不仿制真实军衔肩章。
// 默认 1em 尺寸跟随军衔文字（globals.css .title .rank-badge），
// 用户主页等场景可传 size（px）放大。

const SHIELD_D =
  "M24 3 L42 8.5 V25 C42 36.5 34.5 42.5 24 45.5 C13.5 42.5 6 36.5 6 25 V8.5 Z";
const STAR_D =
  "M0 -10 L2.25 -3.09 L9.51 -3.09 L3.63 1.18 L5.88 8.09 L0 3.82 L-5.88 8.09 L-3.63 1.18 L-9.51 -3.09 L-2.25 -3.09 Z";
const CHEVRON_D = "M-8 3.5 L0 -4 L8 3.5";

// Monokai 军衔配色（与 legacy-2013.css 军衔文字色一致）
const GOLD = "#e6db74"; // 大元帅/元帅、将官星
const GENERAL = "#f79646"; // 将官
const COLONEL = "#e26b0a"; // 校官
const CAPTAIN = "#9bbb59"; // 尉官
const SERGEANT = "#b1b1a4"; // 士官
const PRIVATE = "#939387"; // 士兵
const RESERVE = "#636359"; // 预备役（空徽章）
const DARK = "#2e2e26"; // 盾底

function Star({ x, y, s, fill }: { x: number; y: number; s: number; fill: string }) {
  return <path d={STAR_D} transform={`translate(${x} ${y}) scale(${s})`} fill={fill} />;
}

function Chevron({ y, s, color }: { y: number; s: number; color: string }) {
  return (
    <path
      d={CHEVRON_D}
      transform={`translate(24 ${y}) scale(${s})`}
      fill="none"
      stroke={color}
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function Laurel({ color }: { color: string }) {
  return (
    <g fill={color} stroke={color}>
      <path d="M24 39.5 C19 38 14.5 34.5 13 29.5" fill="none" strokeWidth={1.3} strokeLinecap="round" />
      <path d="M24 39.5 C29 38 33.5 34.5 35 29.5" fill="none" strokeWidth={1.3} strokeLinecap="round" />
      <ellipse cx={19.6} cy={37.2} rx={2.4} ry={1.1} transform="rotate(-25 19.6 37.2)" stroke="none" />
      <ellipse cx={16.2} cy={34.6} rx={2.4} ry={1.1} transform="rotate(-45 16.2 34.6)" stroke="none" />
      <ellipse cx={13.9} cy={31} rx={2.4} ry={1.1} transform="rotate(-65 13.9 31)" stroke="none" />
      <ellipse cx={28.4} cy={37.2} rx={2.4} ry={1.1} transform="rotate(25 28.4 37.2)" stroke="none" />
      <ellipse cx={31.8} cy={34.6} rx={2.4} ry={1.1} transform="rotate(45 31.8 34.6)" stroke="none" />
      <ellipse cx={34.1} cy={31} rx={2.4} ry={1.1} transform="rotate(65 34.1 31)" stroke="none" />
    </g>
  );
}

function Mine({ x, y, s, color }: { x: number; y: number; s: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill={color} stroke={color}>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <line
          key={deg}
          x1={6.6}
          y1={0}
          x2={10}
          y2={0}
          strokeWidth={1.8}
          strokeLinecap="round"
          transform={`rotate(${deg})`}
        />
      ))}
      <circle r={5.4} stroke="none" />
      <circle cx={-1.7} cy={-1.7} r={1.3} fill="#f8f8f2" opacity={0.45} stroke="none" />
    </g>
  );
}

/** 每级徽章的盾形内图案（盾形底板统一在此渲染） */
function RankArt({ title }: { title: string }) {
  switch (title) {
    // ---- 帅：大元帅与元帅完全同款、整体反色 ----
    case "大元帅":
      return (
        <>
          <path d={SHIELD_D} fill={GOLD} stroke={DARK} strokeWidth={2.6} />
          <Star x={24} y={21.5} s={1.02} fill={DARK} />
          <Laurel color={DARK} />
        </>
      );
    case "元帅":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={GOLD} strokeWidth={2.6} />
          <Star x={24} y={21.5} s={1.02} fill={GOLD} />
          <Laurel color={GOLD} />
        </>
      );
    // ---- 将官：金星 + 月桂 ----
    case "大将":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={GENERAL} strokeWidth={2.4} />
          <Star x={18.5} y={14.5} s={0.62} fill={GOLD} />
          <Star x={29.5} y={14.5} s={0.62} fill={GOLD} />
          <Star x={18.5} y={23.5} s={0.62} fill={GOLD} />
          <Star x={29.5} y={23.5} s={0.62} fill={GOLD} />
          <Laurel color={GENERAL} />
        </>
      );
    case "上将":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={GENERAL} strokeWidth={2.4} />
          <Star x={14} y={19.5} s={0.68} fill={GOLD} />
          <Star x={24} y={19.5} s={0.68} fill={GOLD} />
          <Star x={34} y={19.5} s={0.68} fill={GOLD} />
          <Laurel color={GENERAL} />
        </>
      );
    case "中将":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={GENERAL} strokeWidth={2.4} />
          <Star x={18.5} y={19.5} s={0.78} fill={GOLD} />
          <Star x={29.5} y={19.5} s={0.78} fill={GOLD} />
          <Laurel color={GENERAL} />
        </>
      );
    case "少将":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={GENERAL} strokeWidth={2.4} />
          <Star x={24} y={19.5} s={0.84} fill={GOLD} />
          <Laurel color={GENERAL} />
        </>
      );
    // ---- 校官：橙星递加 ----
    case "大校":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={COLONEL} strokeWidth={2.2} />
          <Star x={18.5} y={19.5} s={0.62} fill={COLONEL} />
          <Star x={29.5} y={19.5} s={0.62} fill={COLONEL} />
          <Star x={18.5} y={29} s={0.62} fill={COLONEL} />
          <Star x={29.5} y={29} s={0.62} fill={COLONEL} />
        </>
      );
    case "上校":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={COLONEL} strokeWidth={2.2} />
          <Star x={14} y={24} s={0.66} fill={COLONEL} />
          <Star x={24} y={24} s={0.66} fill={COLONEL} />
          <Star x={34} y={24} s={0.66} fill={COLONEL} />
        </>
      );
    case "中校":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={COLONEL} strokeWidth={2.2} />
          <Star x={18.5} y={24} s={0.7} fill={COLONEL} />
          <Star x={29.5} y={24} s={0.7} fill={COLONEL} />
        </>
      );
    case "少校":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={COLONEL} strokeWidth={2.2} />
          <Star x={24} y={24} s={0.76} fill={COLONEL} />
        </>
      );
    // ---- 尉官：绿星递加 ----
    case "上尉":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={CAPTAIN} strokeWidth={2.2} />
          <Star x={14} y={24} s={0.56} fill={CAPTAIN} />
          <Star x={24} y={24} s={0.56} fill={CAPTAIN} />
          <Star x={34} y={24} s={0.56} fill={CAPTAIN} />
        </>
      );
    case "中尉":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={CAPTAIN} strokeWidth={2.2} />
          <Star x={18.5} y={24} s={0.6} fill={CAPTAIN} />
          <Star x={29.5} y={24} s={0.6} fill={CAPTAIN} />
        </>
      );
    case "少尉":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={CAPTAIN} strokeWidth={2.2} />
          <Star x={24} y={24} s={0.66} fill={CAPTAIN} />
        </>
      );
    // ---- 士官：V 拐递加 ----
    case "上士":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={SERGEANT} strokeWidth={2.2} />
          <Chevron y={17} s={0.9} color={SERGEANT} />
          <Chevron y={25} s={0.9} color={SERGEANT} />
          <Chevron y={33} s={0.9} color={SERGEANT} />
        </>
      );
    case "中士":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={SERGEANT} strokeWidth={2.2} />
          <Chevron y={21} s={0.95} color={SERGEANT} />
          <Chevron y={30} s={0.95} color={SERGEANT} />
        </>
      );
    case "下士":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={SERGEANT} strokeWidth={2.2} />
          <Chevron y={26} s={1} color={SERGEANT} />
        </>
      );
    // ---- 士兵：扫雷主题 ----
    case "上等兵":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={PRIVATE} strokeWidth={2.2} />
          <Chevron y={15} s={0.8} color={PRIVATE} />
          <Mine x={24} y={28} s={0.95} color={PRIVATE} />
        </>
      );
    case "列兵":
      return (
        <>
          <path d={SHIELD_D} fill={DARK} stroke={PRIVATE} strokeWidth={2.2} />
          <Mine x={24} y={24} s={1} color={PRIVATE} />
        </>
      );
    // ---- 预备役：未加入排行的玩家，空徽章 ----
    case "预备役":
      return <path d={SHIELD_D} fill={DARK} stroke={RESERVE} strokeWidth={2.2} />;
    default:
      return null;
  }
}

/**
 * 军衔徽章图标。
 * 不传 size 时为 1em（跟随军衔文字大小，见 globals.css）；
 * 传 size（px）用于用户主页等需要放大的场景。
 */
export function RankBadge({ title, size }: { title: string; size?: number }) {
  const art = RankArt({ title });
  if (!art) return null;
  return (
    <svg
      viewBox="0 0 48 48"
      className="rank-badge"
      aria-hidden="true"
      focusable="false"
      style={size ? { width: size, height: size } : undefined}
    >
      {art}
    </svg>
  );
}
