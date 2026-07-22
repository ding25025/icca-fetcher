#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
環狀資料表（Ring Buffer）工具 — Python 版
=================================================
針對 UnvalidatedDevicePeriodicData_00 ~ _25 這種「循環寫入」的資料表：
資料輪流寫進 N 張表，寫到最後一張再繞回第一張，最新的那張表會一直輪動。

做法：對每張表跑 SELECT MAX(時間欄), COUNT(*)，時間最新的那張就是目前的
「寫入頭 (head)」；從 head 往回繞即可排出由新到舊的順序。掃描採「平行」執行。

三種模式（設定檔的 "mode"）：
  head    只找出目前的寫入頭是哪一張表
  order   列出所有表由新到舊（或舊到新）的順序與各表狀態
  latest  從 head 開始跨表撈出「最新 N 筆」資料，輸出成 JSON

用法：
  python ring.py                    使用 ring_config.json
  python ring.py --config my.json   指定設定檔
  python ring.py --mode head        覆寫模式
  python ring.py --out result.json  覆寫輸出檔
  python ring.py --pretty
"""

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time

import pyodbc

IDENT_RE = re.compile(r"^[A-Za-z0-9_]+$")


# ---------- 工具函式 ----------
def resolve_secret(value):
    """密碼/帳號可寫成 "env:變數名"，改從環境變數讀取。"""
    if isinstance(value, str) and value.startswith("env:"):
        key = value[4:]
        v = os.environ.get(key)
        if v is None:
            raise RuntimeError(f"環境變數 {key} 未設定")
        return v
    return value


def safe_ident(name, label):
    """識別字（表名/欄名）白名單檢查，防止 SQL injection。"""
    if not IDENT_RE.match(str(name)):
        raise RuntimeError(f"{label} 含有不允許的字元：{name}")
    return name


def build_conn_str(conn):
    """組出 pyodbc 連線字串，支援 SQL 帳密登入與 Windows 整合驗證。"""
    driver = conn.get("driver", "ODBC Driver 18 for SQL Server")
    server = conn["server"]
    database = conn["database"]
    parts = [f"DRIVER={{{driver}}}", f"SERVER={server}", f"DATABASE={database}"]

    auth = conn.get("auth", "sql").lower()
    if auth in ("windows", "trusted", "integrated"):
        parts.append("Trusted_Connection=yes")
    else:
        user = resolve_secret(conn.get("user"))
        password = resolve_secret(conn.get("password"))
        parts.append(f"UID={user}")
        parts.append(f"PWD={password}")

    parts.append("Encrypt=yes" if conn.get("encrypt", False) else "Encrypt=no")
    if conn.get("trustServerCertificate", False):
        parts.append("TrustServerCertificate=yes")
    return ";".join(parts) + ";"


def build_table_names(ring):
    prefix = ring["tablePrefix"]
    safe_ident(prefix, "tablePrefix")
    start = ring.get("start", 0)
    count = ring["count"]
    pad = ring.get("pad", 2)
    if count < 1:
        raise RuntimeError("ring.count 必須 >= 1")
    return [{"index": i, "table": f"{prefix}{str(start + i).zfill(pad)}"} for i in range(count)]


def json_default(o):
    if isinstance(o, (datetime, date, time)):
        return o.isoformat()
    if isinstance(o, (bytes, bytearray)):
        return o.hex()
    return str(o)


# ---------- 掃描單一表（每個執行緒各自開連線）----------
def scan_one(conn_str, table, time_col, timeout):
    table = safe_ident(table, "table")
    time_col = safe_ident(time_col, "timeColumn")
    cn = pyodbc.connect(conn_str, timeout=timeout)
    try:
        cur = cn.cursor()
        cur.execute(
            f"SELECT MAX([{time_col}]) AS maxTime, MIN([{time_col}]) AS minTime, "
            f"COUNT_BIG(*) AS cnt FROM [{table}]"
        )
        row = cur.fetchone()
        return {
            "table": table,
            "maxTime": row[0],
            "minTime": row[1],
            "count": int(row[2]) if row[2] is not None else 0,
            "error": None,
        }
    finally:
        cn.close()


def scan_ring(conn_str, tables, ring, timeout, max_workers):
    time_col = ring["timeColumn"]
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {
            ex.submit(scan_one, conn_str, t["table"], time_col, timeout): t
            for t in tables
        }
        for fut in as_completed(futs):
            t = futs[fut]
            try:
                r = fut.result()
                r["index"] = t["index"]
                results[t["index"]] = r
            except Exception as e:  # 單張表失敗不影響其它
                results[t["index"]] = {
                    "index": t["index"], "table": t["table"],
                    "maxTime": None, "minTime": None, "count": 0, "error": str(e),
                }
    # 依 index 排回原順序
    return [results[t["index"]] for t in tables]


def to_epoch(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.timestamp()
    try:
        return datetime.fromisoformat(str(v)).timestamp()
    except Exception:
        return None


def find_head(stats):
    """maxTime 最新的那張表就是寫入頭。"""
    head = None
    for s in stats:
        ts = to_epoch(s["maxTime"])
        if ts is None:
            continue
        if head is None or ts > head["_ts"]:
            head = {**s, "_ts": ts}
    return head


def order_from_head(stats, head_index, direction):
    """從 head 往回繞：head, head-1, ... 繞一圈。"""
    n = len(stats)
    by_index = {s["index"]: s for s in stats}
    ordered = [by_index[(head_index - k) % n] for k in range(n)]
    return list(reversed(ordered)) if direction == "oldToNew" else ordered


# ---------- 撈最新 N 筆（從 head 跨表往回取）----------
def fetch_latest(conn_str, ordered_new_to_old, ring, latest_n, timeout):
    order_col = safe_ident(ring.get("orderColumn") or ring["timeColumn"], "orderColumn")
    select_clause = (ring.get("select") or "*").strip() or "*"
    rows = []
    cn = pyodbc.connect(conn_str, timeout=timeout)
    try:
        cur = cn.cursor()
        for s in ordered_new_to_old:
            if len(rows) >= latest_n:
                break
            if s["count"] == 0 or s["error"]:
                continue
            table = safe_ident(s["table"], "table")
            remaining = latest_n - len(rows)
            cur.execute(
                f"SELECT TOP (?) {select_clause} FROM [{table}] ORDER BY [{order_col}] DESC",
                remaining,
            )
            cols = [c[0] for c in cur.description]
            for r in cur.fetchall():
                obj = {"_sourceTable": table}
                obj.update(dict(zip(cols, r)))
                rows.append(obj)
    finally:
        cn.close()
    return rows


# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser(description="環狀資料表工具 (Python)")
    ap.add_argument("-c", "--config", default="ring_config.json")
    ap.add_argument("-m", "--mode", choices=["head", "order", "latest"])
    ap.add_argument("-o", "--out")
    ap.add_argument("-p", "--pretty", action="store_true")
    args = ap.parse_args()

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    ring = cfg["ring"]
    mode = args.mode or cfg.get("mode", "head")
    out_file = args.out or cfg.get("output", "ring-result.json")
    direction = cfg.get("direction", "newToOld")
    latest_n = cfg.get("latestN", 100)
    timeout = cfg.get("queryTimeoutSec", 60)
    max_workers = cfg.get("maxWorkers", 8)

    conn_str = build_conn_str(cfg["connection"])
    tables = build_table_names(ring)
    print(f"連線中，平行掃描 {len(tables)} 張環狀資料表（workers={max_workers}）...")

    stats = scan_ring(conn_str, tables, ring, timeout, max_workers)
    for s in stats:
        if s["error"]:
            print(f"  ⚠ {s['table']} 掃描失敗：{s['error']}", file=sys.stderr)

    head = find_head(stats)
    if head is None:
        print("錯誤：所有資料表都沒有可用的時間資料，無法判斷寫入頭", file=sys.stderr)
        sys.exit(1)

    print(f"目前寫入頭 (head)：{head['table']}")
    print(f"  最後一筆時間：{head['maxTime']}（共 {head['count']} 筆）")

    ordered = order_from_head(stats, head["index"], direction)
    ordered_new_to_old = list(reversed(ordered)) if direction == "oldToNew" else ordered

    if mode == "head":
        output = {
            "headTable": head["table"],
            "headIndex": head["index"],
            "lastRecordTime": head["maxTime"],
            "totalRows": sum(s["count"] for s in stats),
        }
    elif mode == "order":
        output = [
            {
                "rank": rank, "table": s["table"], "index": s["index"],
                "maxTime": s["maxTime"], "minTime": s["minTime"],
                "count": s["count"], "isHead": s["index"] == head["index"],
                "error": s["error"],
            }
            for rank, s in enumerate(ordered)
        ]
        print(f"已排出 {direction} 順序（rank 0 = {ordered[0]['table']}）")
    else:  # latest
        rows = fetch_latest(conn_str, ordered_new_to_old, ring, latest_n, timeout)
        if direction == "oldToNew":
            rows = list(reversed(rows))
        output = rows
        print(f"已跨表撈出最新 {len(rows)} 筆（目標 {latest_n}）")

    indent = 2 if args.pretty else None
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=indent, default=json_default)
    print("----------------------------------------")
    print(f"已輸出：{os.path.abspath(out_file)}")


if __name__ == "__main__":
    main()
