# fix-board-numbers.py —— 修复旧 PHP renderBoard 负偏移回绕 bug 烙进 video_info.board 的左列数字
# 背景：旧 PHP 的 "$row[-1]" 会回绕取到行尾，导致棋盘最左列把同行最右格误算为邻居，
# 左列数字在右边缘有雷时虚高（2026-10-13 张老师对照 Arbiter 实局发现，录像 345109 有 9 格错）。
# 雷位('*')全部正确，数字无损重算即可，无需重解析录像文件。
# 用法：
#   python3 fix-board-numbers.py            # 干跑：只统计会改多少行，不写库
#   python3 fix-board-numbers.py --apply    # 备份后正式重算
#   python3 fix-board-numbers.py --apply --host H --user U --password P --database D
import argparse
import pymysql

DIMS = {64: (8, 8), 256: (16, 16), 480: (30, 16)}  # len -> (w, h)
BACKUP_TABLE = "video_info_board_bak_20261013"


def recompute(board: str, w: int, h: int) -> str:
    cells = list(board)

    def at(y: int, x: int) -> str:
        if y < 0 or y >= h or x < 0 or x >= w:
            return ""
        return cells[y * w + x]

    for y in range(h):
        for x in range(w):
            i = y * w + x
            if cells[i] == "*":
                continue
            n = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not dy and not dx:
                        continue
                    if at(y + dy, x + dx) == "*":
                        n += 1
            cells[i] = str(n)
    return "".join(cells)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="实际写库（默认干跑）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3306)
    ap.add_argument("--user", default="root")
    ap.add_argument("--password", default="")
    ap.add_argument("--database", default="saolei")
    ap.add_argument("--batch", type=int, default=5000)
    args = ap.parse_args()

    my = pymysql.connect(host=args.host, port=args.port, user=args.user, password=args.password,
                         database=args.database, charset="utf8mb4", autocommit=False)
    cur = my.cursor()

    cur.execute("SELECT id, board FROM video_info WHERE CHAR_LENGTH(board) IN (64,256,480)")
    rows = cur.fetchall()
    print(f"待检查 {len(rows)} 行")

    changed: list[tuple[str, int]] = []
    bad_len = 0
    for vid, board in rows:
        dims = DIMS.get(len(board))
        if not dims:
            bad_len += 1
            continue
        fixed = recompute(board, *dims)
        if fixed != board:
            changed.append((fixed, vid))
    print(f"需修正 {len(changed)} 行；长度异常跳过 {bad_len} 行")

    if not args.apply:
        print("干跑结束（--apply 才会写库）")
        return

    # 备份：仅首次运行时建表
    cur.execute(f"SHOW TABLES LIKE '{BACKUP_TABLE}'")
    if not cur.fetchone():
        cur.execute(f"CREATE TABLE {BACKUP_TABLE} AS "
                    "SELECT id, board FROM video_info WHERE CHAR_LENGTH(board) IN (64,256,480)")
        my.commit()
        print(f"已备份原 board 到 {BACKUP_TABLE}")
    else:
        print(f"备份表 {BACKUP_TABLE} 已存在，跳过备份")

    done = 0
    for i in range(0, len(changed), args.batch):
        part = changed[i:i + args.batch]
        cur.executemany("UPDATE video_info SET board=%s WHERE id=%s", part)
        my.commit()
        done += len(part)
        print(f"已更新 {done}/{len(changed)}")
    print("完成")


if __name__ == "__main__":
    main()
