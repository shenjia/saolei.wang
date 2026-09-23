// 一星卡照片：avatar 标志位为 "1" 时按旧版约定路径加载，加载失败回退问号占位（2008 版 No.jpg 语义）
// useEffect 兜底：图片在 hydration 前就已加载失败时 onError 不会触发，需主动检查 complete/naturalWidth

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function StarPhoto({ id, name, hasPhoto }: { id: number; name: string; hasPhoto: boolean }) {
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.complete && ref.current.naturalWidth === 0) setErr(true);
  }, []);
  if (!hasPhoto || err) {
    return (
      <Link href="/page/help/avatar" target="_blank" title="如何上传照片？">
        <span className="photo empty">?</span>
      </Link>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={`/images/player/${id}.jpg`}
      alt={name}
      className="photo"
      onError={() => setErr(true)}
    />
  );
}
