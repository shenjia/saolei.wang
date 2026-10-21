// 大段文字输入的秒级草稿备份（2026-10-22 张老师要求）
// - 可能输入大段文字的输入框（评论/私信/广播/BBS 发帖回帖/纪事）键入即备份到 localStorage，
//   误关页面/浮窗后重新打开自动恢复，成功发布后清空
// - key 按作者 uid + 属主 ID 隔离（评论=录像、私信=收件人、回帖=主题……），
//   共用电脑换账号登录拿不到别人的草稿
// - 读值走 useSyncExternalStore：SSR/水合期返回 ""（与 LoginPanel 同款，不产生水合警告），
//   水合完成后自动切到 localStorage 实值——受控输入直接绑 value 即完成恢复，无需 effect 消费
// - 「无草稿」与「草稿为空串」区分（has）：用户清空输入框存的是空串草稿，
//   clear() 才是整键移除——回落场景（如编辑纪事回落已保存内容）靠 has 判断
// - 7 天过期：久远残留草稿静默丢弃（存 {v,t} JSON）
// - localStorage 不可用（隐私模式等）静默降级为内存态：不备份但不影响输入

"use client";

import { useCallback, useSyncExternalStore } from "react";

const PREFIX = "draft:";
const EXPIRE_MS = 7 * 24 * 3600 * 1000;

/** 同页所有 useDraft 实例的变更通知（写后即知会；跨 key 实例只会多读一次各自快照，值不变不重渲染） */
const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

/** localStorage 写失败（隐私模式/超限）时的内存兜底：输入不中断，只是不持久化 */
const memFallback = new Map<string, string>();

interface DraftPayload {
  v: string;
  t: number;
}

/** 原始读取：无草稿返回 null（区别于空串草稿）；过期视为无草稿并顺手续期清理 */
function readRaw(key: string): DraftPayload | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFIX + key);
  } catch {
    raw = null;
  }
  if (raw == null) {
    const m = memFallback.get(key);
    return m == null ? null : { v: m, t: Date.now() };
  }
  try {
    const p = JSON.parse(raw) as DraftPayload;
    if (typeof p?.v !== "string") return null;
    if (Date.now() - (p.t ?? 0) > EXPIRE_MS) {
      try {
        localStorage.removeItem(PREFIX + key);
      } catch {
        /* 忽略 */
      }
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  const payload = JSON.stringify({ v: value, t: Date.now() });
  try {
    localStorage.setItem(PREFIX + key, payload);
    memFallback.delete(key);
  } catch {
    memFallback.set(key, value);
  }
}

/** 快照缓存：useSyncExternalStore 的 getSnapshot 必须返回稳定引用——
 *  每次现解析 JSON 会造新对象，水合期即触发「getSnapshot should be cached」
 *  无限循环致整树崩溃（2026-10-22 冒烟实测：带草稿 reload 必炸）。
 *  写路径同步更新缓存；跨页签变更由 storage 事件驱动刷新。 */
const snapCache = new Map<string, DraftPayload | null>();

function getSnapshotOf(key: string): DraftPayload | null {
  if (!snapCache.has(key)) snapCache.set(key, readRaw(key));
  return snapCache.get(key) ?? null;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith(PREFIX)) snapCache.delete(e.key.slice(PREFIX.length));
  });
}

/** 大段文字输入框的草稿状态。
 *  受控输入直接 value={draft.value}：水合前恒 ""（SSR 一致），水合后自动变为存稿；
 *  set 键入即写盘（空串也存——「用户清空」≠「无草稿」）；clear 发布成功后整键移除；
 *  需要回落初值（如编辑态回落已保存内容）用 has 判断。 */
export function useDraft(key: string | null) {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  const getSnapshot = useCallback(
    () => (key == null ? null : getSnapshotOf(key)),
    [key]
  );
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const set = useCallback(
    (v: string) => {
      if (key == null) return;
      writeRaw(key, v);
      snapCache.set(key, { v, t: Date.now() });
      notify();
    },
    [key]
  );
  const clear = useCallback(() => {
    if (key == null) return;
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* 忽略 */
    }
    memFallback.delete(key);
    snapCache.set(key, null);
    notify();
  }, [key]);

  return { value: snap?.v ?? "", has: snap != null, set, clear };
}

/** 「已用草稿挂载过」的表单（模块级单向锚）：contenteditable 画布非受控，
 *  草稿恢复需 key 翻转重挂——本页会话内一旦用过草稿挂载就恒用（防「清空画布→
 *  草稿变空串→key 回翻→重挂丢焦点」的抖动）。渲染期写 Set 幂等，Strict Mode 双渲染安全。 */
const draftMounted = new Set<string>();
export function useDraftCanvasMount(key: string, eligible: boolean): boolean {
  if (eligible && key) draftMounted.add(key);
  return key != null && draftMounted.has(key);
}

/** 是否已完成客户端水合（SSR/首帧恒 false，其后恒 true）——供「水合后才能确定的初值」场景 */
const noopSubscribe = () => () => {};
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}
