#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""344560 混合行手工修复（迁移后补丁）
背景：344560 是 10-13 同步前就存在的混合行（新站高思坦 10-09 上传占位），
mixed 判定窗（id>345158）没覆盖它 → 迁移后仍显示高思坦，孙韩的旧站真值没恢复。
修复：高思坦六表行挪新自增 id → 344560 原位恢复孙韩行（旧站终态）→ news 引用改写。
用法：SAOLEI_DB_* 指向目标库，python fix-344560.py [--allow-nonlocal]
"""
import os
import sys

import pymysql


def conn():
    return pymysql.connect(
        host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
        user=os.environ.get("SAOLEI_DB_USER", "root"),
        password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
        database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
        charset="utf8mb4", autocommit=False)


VID = 344560
OLD_OWNER = 30532   # 孙韩（旧站终态真值）
GAO = 19528         # 高思坦（新站上传者，行挪新 id）

# 高思坦 344560 的完整行（取自迁移前生产备份 merge-backup-20261022-071309）
GAO_VIDEO = "('exp',{g},'0a9aa4a11c7274055ac72b607f4c2fe1',20,1,1792203717,1791530159,1792203717,0,49880,1,1,0)"
GAO_VINFO = ('/2026/10/9/0a9aa4a11c7274055ac72b607f4c2fe1.avf', 'Gao Si Tan (China)', 'Arbiter', '0.52', 1,
             '01**201110001*101*10012*2111**025*301*22122210233212*22*124*01**2023*3*2*1001**3*3222232*30233101*3*23220013*312*11*3*4*12*100112111*21001122321113*31*322111000012*211012**1000122123*11*111100112*223*32100001*11*222211*11110112**222221101111111*101111*101233211**4*21221001232111111101**100124**22**2111*2*12*31000234321002*423**2*3222112**31012*2**112333*2232*4*100014**201*233311**2*4311**41212112**312111*3234432**111*312*3*32433*10134**3**112321012*213*3*2*21101**3233*31001*10',
             166, 61370, 1791530159, 1791530159)
GAO_VSTAT = (15, '223.88.230.177', 7, '57.141.22.127', 0, 1791530159, 1792618875, 0)
GAO_SCORE = (61370, 2705, 1791530159)


def main():
    allowed = "--allow-nonlocal" in sys.argv
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = os.environ.get("SAOLEI_DB_PORT", "3306")
    if (host, port) != ("127.0.0.1", "3306") and not allowed:
        sys.exit("非本地库需 --allow-nonlocal")

    my = conn()
    c = my.cursor()

    # 幂等：344560 已是孙韩则跳过
    c.execute("SELECT user FROM video WHERE id=%s", (VID,))
    row = c.fetchone()
    if row and row[0] == OLD_OWNER:
        print("already fixed, skip")
        my.close()
        return

    try:
        # 1) 高思坦行挪新 id（六表 + news）
        gsql = GAO_VIDEO.format(g=GAO)
        c.execute(f"INSERT INTO video (level,user,hash,status,review_user,review_time,"
                  f"create_time,update_time,status_bak,exp_time,ranked,auto_flag,auto_reason) "
                  f"VALUES {gsql}")
        new_id = c.lastrowid
        c.execute("INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,"
                  "board_3bv,real_time,create_time,update_time) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                  (new_id,) + GAO_VINFO)
        c.execute("INSERT INTO video_stat (id,clicks,clicker,downloads,downloader,comments,"
                  "create_time,update_time,admin_watched) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                  (new_id,) + GAO_VSTAT)
        for tbl in ("video_scores_exp", "video_scores_exp_nf"):
            c.execute(f"INSERT INTO `{tbl}` (id,user,score_time,score_3bvs,create_time) "
                      f"VALUES (%s,%s,%s,%s,%s)", (new_id, GAO) + GAO_SCORE)
        c.execute("UPDATE news SET reference=%s WHERE type IN (20,30) AND reference=%s",
                  (new_id, VID))
        # 2) 344560 原位恢复孙韩（旧站终态：09-23 20:08:43 上传、44.48s、3bv155、NF）
        ct = 1792200523  # 2026-09-23 20:08:43 +08
        c.execute("UPDATE video SET user=%s, hash='', create_time=%s, update_time=%s WHERE id=%s",
                  (OLD_OWNER, ct, ct, VID))
        c.execute("DELETE FROM video_info WHERE id=%s", (VID,))
        c.execute("INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,"
                  "board_3bv,real_time,create_time,update_time) VALUES "
                  "(%s,'/Video/Mvf/30532/Sun Han_Exp_44.48(3bv155).avf','Sun Han','','',1,'',155,43480,%s,0)",
                  (VID, ct))
        c.execute("DELETE FROM video_stat WHERE id=%s", (VID,))
        c.execute("INSERT INTO video_stat (id,clicks,create_time) VALUES (%s,0,%s)", (VID, ct))
        for tbl in ("video_scores_exp", "video_scores_exp_nf"):
            c.execute(f"DELETE FROM `{tbl}` WHERE id=%s", (VID,))
            c.execute(f"INSERT INTO `{tbl}` (id,user,score_time,score_3bvs,create_time) "
                      f"VALUES (%s,%s,%s,%s,%s)", (VID, OLD_OWNER, 43480, 3564, ct))
        my.commit()
        print(f"FIXED: Gao→{new_id}, 344560→孙韩(30532)")
    except Exception:
        my.rollback()
        raise
    my.close()


if __name__ == "__main__":
    main()
