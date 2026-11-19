/* 回放/练习音效播放器（Web Audio 版，2026-11-13 移动端开声音卡顿修复）
 *
 * 旧实现（HTMLAudioElement retrigger：currentTime=0 + play()）在移动端
 * WebKit（iOS Safari / 微信内置 / 国产壳等）上每次重触发都要走媒体管线
 * seek + 重启，主线程可感知停顿 → 回放 rAF 掉帧，表现＝开声音后播放一顿
 * 一顿；桌面端媒体管线便宜所以无感。Web Audio 路线：AudioContext +
 * decodeAudioData 一次性解码缓存，每次播放只建 BufferSource（近零开销、
 * 采样级重触发），同 src 重播 stop 上一条（保持旧「复用同一元素不叠加」口径）。
 *
 * iOS 硬性约束：AudioContext 必须在用户手势内创建/resume——模块加载时挂
 * 一次性 pointerdown 解锁（回放一定由点击/触摸触发），解锁后顺带预取解码
 * sfxPrefetch 注册的清单（回放全套音效 <50KB，首个音效前就绪）。
 * Web Audio 不可用 / ctx 未 running / 解码失败一律回退旧 HTMLAudioElement
 * 路径（行为与旧版完全一致——只会更好不会更坏）。
 */

let ctx: AudioContext | null = null;
let unlocked = false;

const bufCache = new Map<string, AudioBuffer>();
const bufPending = new Map<string, Promise<AudioBuffer | null>>();
/* 同 src 当前在播的 source（重触发 stop 上一条，模拟旧元素复用不叠加） */
const liveSrc = new Map<string, AudioBufferSourceNode>();

/* Web Audio 不可用/未就绪时的兜底路径：旧 HTMLAudioElement retrigger */
const elCache = new Map<string, HTMLAudioElement>();
function elPlay(src: string) {
  try {
    let a = elCache.get(src);
    if (!a) {
      a = new Audio(src);
      a.preload = "auto";
      elCache.set(src, a);
    } else {
      try {
        a.currentTime = 0; // 同 src 复播从头（连发场景上一条可能未播完）
      } catch {
        /* 已在播等异常忽略 */
      }
    }
    void a.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

function getBuf(src: string): Promise<AudioBuffer | null> {
  const c = ctx;
  if (!c) return Promise.resolve(null);
  const hit = bufCache.get(src);
  if (hit) return Promise.resolve(hit);
  let p = bufPending.get(src);
  if (p) return p;
  p = new Promise<AudioBuffer | null>((resolve) => {
    fetch(src)
      .then((r) =>
        r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))),
      )
      .then((ab) => {
        /* callback 形式兼容老 WebKit（promise 形式老 Safari 不支持） */
        c.decodeAudioData(
          ab,
          (buf) => {
            bufCache.set(src, buf);
            bufPending.delete(src);
            resolve(buf);
          },
          () => {
            bufPending.delete(src);
            resolve(null);
          },
        );
      })
      .catch(() => {
        bufPending.delete(src);
        resolve(null);
      });
  });
  bufPending.set(src, p);
  return p;
}

/* 预取清单：解锁后逐个 fetch+decode，首个音效前就绪 */
let prefetchList: string[] = [];
export function sfxPrefetch(srcs: string[]) {
  prefetchList = srcs.slice();
  if (unlocked && ctx) for (const s of srcs) void getBuf(s);
}

/* 用户手势内调用（模块级 pointerdown 一次性挂载）：创建/resume AudioContext */
export function sfxUnlock() {
  if (unlocked) return;
  const c = ensureCtx();
  if (!c) return;
  unlocked = true;
  void c.resume().catch(() => {});
  for (const s of prefetchList) void getBuf(s);
}

export function sfxPlay(src: string) {
  const c = ctx;
  if (!c || c.state !== "running") {
    elPlay(src);
    return;
  }
  void getBuf(src).then((buf) => {
    if (!buf) {
      elPlay(src);
      return;
    }
    const prev = liveSrc.get(src);
    try {
      prev?.stop();
    } catch {
      /* 已结束等异常忽略 */
    }
    const s = c.createBufferSource();
    s.buffer = buf;
    s.connect(c.destination);
    s.onended = () => {
      if (liveSrc.get(src) === s) liveSrc.delete(src);
    };
    liveSrc.set(src, s);
    s.start();
  });
}

/* 回放一定由点击/触摸触发：首个 pointerdown 即在手势内解锁 */
if (typeof document !== "undefined") {
  const onGesture = () => {
    sfxUnlock();
    document.removeEventListener("pointerdown", onGesture);
  };
  document.addEventListener("pointerdown", onGesture, { passive: true });
}
