#!/usr/bin/env python3
"""favicon.ico 无损瘦身 ×2：从 git HEAD 旧版取源，产出两个文件——
① public/favicon.ico（全站）：四帧 16/24/32/48 原样保留，64 色量化重压，
   差异仅 alpha 抗锯齿边缘带（≤15/2-6% 像素，肉眼不可辨）。8.4KB → ~3KB。
   （2026-11-11 favicon 按环境切换改造：图标移出 src/app 文件约定 → public/，
   由 layout.tsx generateMetadata.icons 控制，本地 dev 用绿色版 icon-dev.svg/png）
② public/images/favicon-mini.ico（挑战页专用极简）：只留 16/32 双帧（浏览器
   标签页场景够用，砍 24 Windows 冗余档与 48 快捷方式档）。~1.4KB。
注意 PIL 的 ICO saver 会丢 append_images 帧，必须手动打包目录+帧。
幂等可重跑：源固定取 git HEAD 的 favicon.ico。"""
import io
import struct
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "public/favicon.ico"
TARGET_MINI = ROOT / "public/images/favicon-mini.ico"

def extract_frames(data: bytes) -> dict[int, Image.Image]:
    count = struct.unpack("<H", data[4:6])[0]
    off, out = 6, {}
    for _ in range(count):
        w, h, _c, _r, _p, _bpp, size, offset = struct.unpack("<BBBBHHII", data[off:off + 16])
        out[w] = Image.open(io.BytesIO(data[offset:offset + size])).convert("RGBA")
        off += 16
    return out

def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True, compress_level=9)
    return buf.getvalue()

def quant(im: Image.Image) -> Image.Image:
    return im.quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)

def pack(frames: dict[int, Image.Image]) -> bytes:
    sizes = sorted(frames)
    entries, payload = [], b""
    for s in sizes:
        png = png_bytes(quant(frames[s]))
        entries.append((s, len(png), 6 + 16 * len(sizes) + len(payload)))
        payload += png
    head = struct.pack("<HHH", 0, 1, len(sizes))
    dir_ = b"".join(
        struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, length, offset)
        for s, length, offset in entries
    )
    return head + dir_ + payload

def verify(data: bytes, expect: list[tuple[int, int]]) -> None:
    img = Image.open(io.BytesIO(data))
    sizes = sorted(img.info.get("sizes", []))
    assert sizes == expect, f"{sizes} != {expect}"
    for s in sizes:
        img.size = s
        img.load()

def main() -> None:
    src_data = subprocess.run(
        ["git", "show", "HEAD:public/favicon.ico"],
        capture_output=True, cwd=ROOT,
    ).stdout
    frames = extract_frames(src_data)
    assert sorted(frames) == [16, 24, 32, 48], sorted(frames)

    # 全站版：四帧全保留
    full = pack(frames)
    verify(full, [(16, 16), (24, 24), (32, 32), (48, 48)])
    TARGET.write_bytes(full)
    print(f"全站 favicon.ico: {len(src_data)}B -> {len(full)}B ({len(src_data) / len(full):.1f}x)")

    # 挑战页极简版：16+32 双帧
    mini = pack({s: frames[s] for s in (16, 32)})
    verify(mini, [(16, 16), (32, 32)])
    TARGET_MINI.parent.mkdir(parents=True, exist_ok=True)
    TARGET_MINI.write_bytes(mini)
    print(f"挑战页 favicon-mini.ico: {len(mini)}B（16+32 双帧）")

if __name__ == "__main__":
    main()
