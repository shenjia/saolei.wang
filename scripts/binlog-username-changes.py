#!/usr/bin/env python3
"""从 mysqlbinlog -vv 输出提取 saolei.user_auth 的 username 变更事件。
用法: mysqlbinlog -vv <files...> | python3 parse_username_changes.py
输出 TSV: 时间  id  old_username  new_username
"""
import re
import sys

table_id = None   # 当前 saolei.user_auth 的 table map 编号
in_event = False  # 正在收集一个 Update_rows 事件
in_set = False    # 已进入 SET（after image）段
event_time = ""
where: dict = {}
after: dict = {}

HDR = re.compile(r"^#(\d{6})\s+(\d{1,2}:\d{2}:\d{2})\s+server id")
TMAP = re.compile(r"Table_map: `saolei`\.`user_auth` mapped to number (\d+)")
UROWS = re.compile(r"Update_rows: table id (\d+)")
FIELD = re.compile(r"^###\s+@(\d+)=(.*)$")


def clean(v: str) -> str:
    v = v.strip()
    m = re.match(r"^'(.*)'/\*", v)
    if m:
        return m.group(1)
    m = re.match(r"^'(.*)'$", v)
    if m:
        return m.group(1)
    return v.split("/*")[0].strip()


def flush():
    global in_event, where, after, in_set
    if in_event:
        o, n = where.get(2), after.get(2)
        if o is not None and n is not None and o != n:
            print(f"{event_time}\t{where.get(1)}\t{o}\t{n}", flush=True)
    in_event = False
    in_set = False
    where, after = {}, {}


for line in sys.stdin:
    line = line.rstrip("\n")
    m = HDR.match(line)
    if m:
        flush()
        event_time = m.group(1) + " " + m.group(2)
        continue
    m = TMAP.search(line)
    if m:
        table_id = m.group(1)
        continue
    m = UROWS.search(line)
    if m and m.group(1) == table_id:
        flush()
        in_event = True
        continue
    if not in_event:
        continue
    if line.strip() == "### SET":
        in_set = True
        continue
    m = FIELD.match(line)
    if m:
        idx = int(m.group(1))
        if idx in (1, 2):
            (after if in_set else where)[idx] = clean(m.group(2))

flush()
