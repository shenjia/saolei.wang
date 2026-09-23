#!/usr/bin/env python3
"""SaoleiNet MSSQL -> MySQL staging (saolei_mssql) 全量抽取
按主键顺序分批流式拉取,断点可续(表已存在且非空则跳过)。"""
import sys, time
import pytds
import pymysql

MSSQL = dict(server=__import__("os").environ.get("SAOLEI_MSSQL_HOST","REDACTED_SERVER_IP"), port=1433, user=__import__("os").environ.get("SAOLEI_MSSQL_USER","saolei"), password=__import__("os").environ["SAOLEI_MSSQL_PASS"],
             database="SaoleiNet", login_timeout=15, timeout=300)
MY = dict(host="127.0.0.1", user="root", database="saolei_mssql",
          charset="utf8mb4", autocommit=False)

# 表定义: (mssql表, 主键, [(列名, 类型)], 文本列转 NVARCHAR(MAX) 的列)
TABLES = {
    "player": ("Player", "Player_Id", None),
    "video": ("Video", "Video_Id", None),
    "news": ("News", "News_Id", None),
    "comment": ("Comment", "Comment_Id", None),
    "title": ("Title", "Title_Id", ["Title_Text"]),
    "history": ("History", "History_Id", None),
    "message": ("Message", "Message_Id", None),
}
BATCH = 5000


def col_type(name, typ, maxlen):
    if typ == "bigint":
        return "BIGINT NULL"
    if typ == "float":
        return "DOUBLE NULL"
    if typ == "datetime":
        return "DATETIME(3) NULL"
    if typ == "bit":
        return "TINYINT(1) NULL"
    if typ in ("varchar", "nvarchar", "ntext"):
        return "MEDIUMTEXT NULL"
    return "MEDIUMTEXT NULL"


def main():
    ms = pytds.connect(**MSSQL)
    my = pymysql.connect(**MY)
    mc = my.cursor()

    for table, (msrc, pk, text_casts) in TABLES.items():
        mc.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='saolei_mssql' AND table_name=%s",
            (table,))
        if mc.fetchone():
            mc.execute(f"SELECT COUNT(*) FROM `{table}`")
            if mc.fetchone()[0] > 0:
                print(f"[skip] {table} 已存在且有数据", flush=True)
                continue

        msc = ms.cursor()
        msc.execute(
            """SELECT c.name, ty.name, c.max_length FROM sys.columns c
               JOIN sys.types ty ON c.user_type_id=ty.user_type_id
               WHERE c.object_id=OBJECT_ID(%s) ORDER BY c.column_id""", (msrc,))
        cols = msc.fetchall()
        colnames = [c[0] for c in cols]

        defs = ", ".join(
            f"`{n}` {col_type(n, t, m).replace('NULL', 'NOT NULL') if n == pk else col_type(n, t, m)}"
            for n, t, m in cols)
        mc.execute(f"CREATE TABLE IF NOT EXISTS `{table}` ({defs}, PRIMARY KEY (`{pk}`)) ENGINE=InnoDB")
        my.commit()

        str_types = {"varchar", "nvarchar"}
        lob_types = {"ntext"}
        select_cols = ", ".join(
            f"CAST([{n}] AS NVARCHAR(MAX)) AS [{n}]" if t in lob_types else
            (f"CAST([{n}] AS NVARCHAR(4000)) AS [{n}]" if t in str_types else f"[{n}]")
            for n, t, m in cols)
        ins = f"INSERT INTO `{table}` (`" + "`,`".join(colnames) + "`) VALUES (" + ",".join(["%s"] * len(colnames)) + ")"

        last = -1
        total = 0
        t0 = time.time()
        while True:
            msc2 = ms.cursor()
            msc2.execute(
                f"SELECT TOP {BATCH} {select_cols} FROM [{msrc}] WHERE [{pk}] > %s ORDER BY [{pk}]",
                (last,))
            rows = msc2.fetchall()
            if not rows:
                break
            mc.executemany(ins, [tuple(r) for r in rows])
            my.commit()
            total += len(rows)
            last = rows[-1][colnames.index(pk)]
            if total % 20000 < BATCH:
                print(f"[{table}] {total} rows, {time.time()-t0:.0f}s", flush=True)
        print(f"[done] {table}: {total} rows in {time.time()-t0:.0f}s", flush=True)

    my.close()
    ms.close()
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
