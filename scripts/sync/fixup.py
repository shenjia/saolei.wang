#!/usr/bin/env python3
"""修复:1) 补插缺失的 video_info 2) 删除 MSSQL 已删除的 155 孤儿录像
3) 清理 status!=20 的 video_scores 行 4) _nf 表以本地 noflag 为准"""
import time
import pymysql

EPOCH_DT = __import__("datetime").datetime(1970, 1, 1)
TZ8 = __import__("datetime").timedelta(hours=8)

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4", autocommit=False)
stg = pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql", charset="utf8mb4", autocommit=True)
cur, sc = my.cursor(), stg.cursor()


def ux(dt):
    return int((dt - TZ8 - EPOCH_DT).total_seconds()) if dt else 0


def t_ms(score):
    return int((score - 1.0) * 1000 + 0.5)


# 1) 补 video_info
sc.execute("""SELECT v.Video_Id, v.Video_Path, v.Video_IsNoFrag, v.Video_3BV, v.Video_Score, v.Video_Time
            FROM Video v LEFT JOIN saolei.video_info i ON i.id=v.Video_Id
            WHERE i.id IS NULL""")
rows = sc.fetchall()
print(f"补 video_info: {len(rows)}")
ins = []
for vid, path, nf, bv, score, vtime in rows:
    ins.append((vid, (path or "")[:100], "", "", "", 1 if nf else 0, "",
                int(round(bv)) if bv is not None else 0,
                t_ms(score) if score is not None else 0, ux(vtime), 0))
for i in range(0, len(ins), 2000):
    cur.executemany("""INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,board_3bv,real_time,create_time,update_time)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", ins[i:i + 2000])
    my.commit()

# 2) 删孤儿录像(MSSQL 已物理删除)
cur.execute("SELECT v.id FROM video v LEFT JOIN saolei_mssql.video mv ON mv.Video_Id=v.id WHERE mv.Video_Id IS NULL")
orphans = [r[0] for r in cur.fetchall()]
print(f"删孤儿录像: {len(orphans)}")
for t in ("video", "video_info", "video_stat", "video_scores_beg", "video_scores_int", "video_scores_exp",
          "video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf"):
    cur.executemany(f"DELETE FROM {t} WHERE id=%s", [(o,) for o in orphans])
my.commit()

# 3) 清理 status!=20 的 scores 行
for t in ("video_scores_beg", "video_scores_int", "video_scores_exp",
          "video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf"):
    cur.execute(f"DELETE s FROM {t} s JOIN video v ON v.id=s.id WHERE v.status<>20")
    print(f"{t} 清理 status!=20: {cur.rowcount}")
my.commit()

# 4) _nf 表以本地 video_info.noflag 为准
for t in ("video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf"):
    cur.execute(f"DELETE s FROM {t} s JOIN video_info i ON i.id=s.id WHERE i.noflag=0")
    print(f"{t} 清理 noflag=0: {cur.rowcount}")
my.commit()

# 5) 补:_nf 表漏插(本地 noflag=1 但不在 _nf 表中的 status=20 录像)
for level in ("beg", "int", "exp"):
    cur.execute(f"""SELECT v.id, v.user, i.real_time, s.score_3bvs, v.create_time
                 FROM video v JOIN video_info i ON i.id=v.id
                 JOIN video_scores_{level} s ON s.id=v.id
                 LEFT JOIN video_scores_{level}_nf n ON n.id=v.id
                 WHERE v.level=%s AND v.status=20 AND i.noflag=1 AND n.id IS NULL""", (level,))
    miss = cur.fetchall()
    if miss:
        cur.executemany(f"""INSERT INTO video_scores_{level}_nf (id,user,score_time,score_3bvs,create_time)
                         VALUES (%s,%s,%s,%s,%s)""", miss)
        my.commit()
    print(f"video_scores_{level}_nf 补插: {len(miss)}")

print("FIXUP DONE")
my.close()
stg.close()
