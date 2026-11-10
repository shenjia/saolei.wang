"use client";

// 头像小图通用组件（2026-11-10 张老师需求：全站头像按展示尺寸加载对应档 WebP 省流量）
//
// 独立客户端组件的原因：onError 回退必须事件处理器（RSC 不允许）。
// 小图缺失（批处理未跑 / 生产 uploads 小图未生成 / CDN 异常）时回退原图，
// 回退前先置空 onerror 防原图也 404 时的循环触发。

export function AvatarImg({
  src,
  fallback,
  className,
  alt = "",
  width,
  height,
}: {
  /** 小图 URL（对应展示档 WebP）；与 fallback 相同时直接原图 */
  src: string;
  /** 原图 URL（回退目标） */
  fallback: string;
  className: string;
  alt?: string;
  width?: number;
  height?: number;
}) {
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      width={width}
      height={height}
      onError={
        src !== fallback
          ? (e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = fallback;
            }
          : undefined
      }
    />
  );
}
