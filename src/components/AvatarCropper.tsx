// 头像方形裁剪弹窗（2026-09-24 张老师需求：选中照片后先出裁剪成方形的预览浮窗，
// 用户确认后再上传，并告知需审核后才生效）
//
// 为什么要裁剪成方形：
//   · 站内头像一律按正方形展示（object-fit: cover），方形输出所见即所得，
//     用户自己决定取景（脸放中间），不会出现系统硬裁把头顶切掉的意外
//   · canvas 导出 400x400 JPEG，同时完成格式归一化与 EXIF 剥离
//
// 交互：短边填满取景框（不留白）→ 拖动调整位置 / 滑块缩放 → 确认上传。
// 本人照片以外的说明文字（仅收真人）与审核流程告知都放在浮窗里，用户一次性看完。

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 取景框显示边长（CSS 像素） */
const VIEW = 300;
/** 导出边长：站内最大展示 160px，400 覆盖 2x 屏还有余量 */
const OUT = 400;
const JPEG_QUALITY = 0.85;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export interface CropResult {
  /** true = AI 放行已直接生效；false = 已提交等待人工审核 */
  auto: boolean;
  message: string;
}

interface Props {
  /** 待裁剪图片的预览 URL（由调用方用 createObjectURL 生成并负责回收） */
  previewUrl: string;
  /** 取消（点取消按钮 / Esc / 点遮罩空白处） */
  onCancel: () => void;
  /** 上传成功 */
  onDone: (result: CropResult) => void;
}

/**
 * 「选图 → 拿到可预览的 object URL」的公共逻辑：主页头像与个人资料页共用。
 * object URL 在事件回调里创建（不在渲染/effect 里 setState），并在换图/卸载时回收。
 */
export function useAvatarPick() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pickedUrl) return;
    return () => URL.revokeObjectURL(pickedUrl);
  }, [pickedUrl]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // 允许连续选同一张图
    if (f) setPickedUrl(URL.createObjectURL(f));
  }

  return { inputRef, pickedUrl, setPickedUrl, onPick };
}

function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

export function AvatarCropper({ previewUrl, onCancel, onDone }: Props) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [phase, setPhase] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** 当前缩放下的图片绘制尺寸 */
  const draw = useCallback(
    (z: number) => {
      if (!size) return { w: 0, h: 0, scale: 1 };
      const base = Math.max(VIEW / size.w, VIEW / size.h);
      const scale = base * z;
      return { w: size.w * scale, h: size.h * scale, scale };
    },
    [size],
  );

  /** 把偏移限制在「图片始终盖满取景框」的范围内 */
  const clampOffset = useCallback(
    (o: { x: number; y: number }, z: number) => {
      const d = draw(z);
      return {
        x: clamp(o.x, VIEW - d.w, 0),
        y: clamp(o.y, VIEW - d.h, 0),
      };
    },
    [draw],
  );

  /** 图片就绪：初始按短边填满并居中 */
  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const el = e.currentTarget;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (!w || !h) {
      setDecodeFailed(true);
      return;
    }
    setSize({ w, h });
    const base = Math.max(VIEW / w, VIEW / h);
    setZoom(MIN_ZOOM);
    setOffset({ x: (VIEW - w * base) / 2, y: (VIEW - h * base) / 2 });
  }

  /** 缩放：以取景框中心为锚点，避免放大时画面跑偏 */
  function changeZoom(z: number) {
    if (!size) return;
    const prev = draw(zoom);
    const next = draw(z);
    // 取景框中心在图片原始坐标中的位置（保持不变）
    const cx = (VIEW / 2 - offset.x) / prev.scale;
    const cy = (VIEW / 2 - offset.y) / prev.scale;
    setZoom(z);
    setOffset(clampOffset({ x: VIEW / 2 - cx * next.scale, y: VIEW / 2 - cy * next.scale }, z));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!size || phase !== "idle") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    setOffset(
      clampOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, zoom),
    );
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  /** 导出 400x400 JPEG 并上传 */
  async function submit() {
    if (!size || phase !== "idle") return;
    setError(null);
    setPhase("uploading");

    const img = imgRef.current;
    if (!img) {
      setPhase("idle");
      setError("图片尚未就绪，请稍后重试");
      return;
    }

    const d = draw(zoom);
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setPhase("idle");
      setError("当前浏览器不支持图片处理，请更换浏览器后重试");
      return;
    }
    // 源区域：取景框在图片中的对应方形区域（浮点误差可能让边界越界，钳一下防 drawImage 抛错）
    const side = Math.min(VIEW / d.scale, Math.min(size.w, size.h));
    const sx = clamp(-offset.x / d.scale, 0, Math.max(0, size.w - side));
    const sy = clamp(-offset.y / d.scale, 0, Math.max(0, size.h - side));
    ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) {
      setPhase("idle");
      setError("图片处理失败，请换一张照片试试");
      return;
    }

    try {
      const fd = new FormData();
      fd.append("avatar", blob, "avatar.jpg");
      const res = await fetch("/api/account/avatar", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase("idle");
        setError(data.error ?? "上传失败，请稍后重试");
        return;
      }
      onDone({ auto: !!data.auto, message: data.message ?? "已提交，等待审核" });
    } catch {
      setPhase("idle");
      setError("网络异常，请稍后重试");
    }
  }

  const d = draw(zoom);
  const busy = phase === "uploading";

  return (
    <div className="avatar_crop_mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="avatar_crop" role="dialog" aria-modal="true" aria-label="裁剪头像">
        <h3>裁剪头像</h3>

        {decodeFailed ? (
          <p className="avatar_crop_error">
            无法读取这张图片，请改用 JPG / PNG 格式的照片（iPhone 的 HEIC 原图请先在相册里导出为 JPG）
          </p>
        ) : (
          <>
            <div
              className="avatar_crop_frame"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {previewUrl && (
                // 用 <img> 解码：Safari 对 iPhone 的 HEIC 原生解码走这条路径
                // （Chrome 解不开 HEIC，会落到 onError → 「无法读取」提示）
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={imgRef}
                  src={previewUrl}
                  alt="待裁剪的照片"
                  draggable={false}
                  onLoad={onImgLoad}
                  onError={() => setDecodeFailed(true)}
                  style={{
                    width: d.w || undefined,
                    height: d.h || undefined,
                    transform: `translate(${offset.x}px, ${offset.y}px)`,
                    visibility: size ? "visible" : "hidden",
                  }}
                />
              )}
              <span className="avatar_crop_cross" />
            </div>

            <p className="avatar_crop_drag">按住照片拖动调整位置</p>

            <div className="avatar_crop_zoom">
              <span>缩放</span>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                disabled={!size || busy}
                onChange={(e) => changeZoom(parseFloat(e.target.value))}
                aria-label="缩放"
              />
            </div>

            <p className="avatar_crop_note">
              头像会裁剪成<b>正方形</b>；提交后<b>需经审核才会生效</b>，审核期间旧头像继续对外展示。
            </p>
            <p className="avatar_crop_note sub">
              仅接受<b>本人真实照片</b>（不收卡通、动漫、风景、表情包）；系统会先自动审核，拿不准的转人工复核。
            </p>
          </>
        )}

        {error && <p className="avatar_crop_error">{error}</p>}

        <div className="avatar_crop_actions">
          <button type="button" className="button active" onClick={submit} disabled={!size || busy || decodeFailed}>
            {busy ? "上传中…" : "确认更换"}
          </button>
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
