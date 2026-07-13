#!/usr/bin/env python3
"""Hybrid search over the local memory vector DB.

Runs a vector search and a keyword (FTS5/BM25) search **in parallel**, fuses the two
ranked lists with Reciprocal Rank Fusion, then reranks by recency (age decay on the
log's date) and a source weight (auto-captured summaries are trusted a little less than
hand-written notes). Prints the top hits with a score breakdown.

    python search_memory.py "why is the DD trailing stop wide"
    python search_memory.py "dd2 telegram" --k 5 --half-life 30
    python search_memory.py "why SQLite" --full   # untruncated content, for quoting
    python search_memory.py "why SQLite" --json    # structured provenance + content

Every result carries a ready-to-paste ``citation`` (source file · date · heading · turn)
so an answer can point at exactly where a fact came from instead of paraphrasing blind.

Tunables live in the CONFIG block below and are meant to be edited.
"""
import os
import re
import sys
import json
import sqlite3
import argparse
from pathlib import Path
from datetime import date
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from memory_embedder import get_embedder

try:  # Windows consoles default to cp1252, which chokes on — … › in log text
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Per-project mode: this copy lives at the project root itself, so the index only ever
# covers this project's own memory/daily logs (see index_memory.py).
SCAN_ROOT = Path(os.environ.get("MEMORY_SCAN_ROOT", Path(__file__).resolve().parent))
DB_PATH = Path(os.environ.get("MEMORY_DB", SCAN_ROOT / "memory" / "memory_index.db"))

# ----------------------------- CONFIG (editable) ---------------------------
RRF_K = 60             # Reciprocal Rank Fusion constant (bigger = flatter fusion)
POOL = 40              # candidates pulled from each channel before fusion
RECENCY_HALF_LIFE = 30.0  # days; a chunk this old counts for half on the recency axis
RECENCY_FLOOR = 0.25   # oldest chunks never fall below this recency multiplier


def source_weight(source: str, heading: str) -> float:
    """Trust weight by where a chunk came from. Edit freely."""
    h = (heading or "").lower()
    if "auto-captured" in h or "session summaries" in h:
        return 0.85          # machine-written recap — slightly discounted
    return 1.0               # hand-written note / everything else
# ---------------------------------------------------------------------------


def _open() -> sqlite3.Connection:
    # read-only; each thread opens its own handle (sqlite connections aren't shareable)
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def vector_search(qvec: np.ndarray, pool: int):
    con = _open()
    try:
        rows = con.execute("SELECT id, embedding FROM chunks").fetchall()
    finally:
        con.close()
    if not rows:
        return []
    ids = np.array([r[0] for r in rows])
    mat = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    sims = mat @ qvec  # rows are L2-normalized, so dot == cosine
    order = np.argsort(-sims)[:pool]
    return [(int(ids[i]), float(sims[i])) for i in order]


_FTS_TOKEN = re.compile(r"[A-Za-z0-9_]+")


def keyword_search(query: str, pool: int):
    terms = _FTS_TOKEN.findall(query.lower())
    if not terms:
        return []
    match = " OR ".join(f"{t}*" for t in terms)  # prefix match, OR-combined
    con = _open()
    try:
        rows = con.execute(
            "SELECT rowid, bm25(chunks_fts) AS s FROM chunks_fts "
            "WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?",
            (match, pool),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()
    return [(int(r[0]), float(r[1])) for r in rows]  # lower bm25 == better


def _rrf(ranked_ids):
    """Reciprocal Rank Fusion over an ordered list of ids -> {id: score}."""
    return {cid: 1.0 / (RRF_K + rank) for rank, cid in enumerate(ranked_ids)}


def _citation(source: str, cdate: str, heading: str, turn: str) -> str:
    """A compact, copy-pasteable pointer to exactly where a chunk lives."""
    parts = [source or "(unknown file)"]
    if cdate:
        parts.append(cdate)
    if heading:
        parts.append(heading)
    cite = " · ".join(parts)
    if turn:
        cite += f" · turn:{turn}"
    return cite


def recency_weight(chunk_date: str, today: date) -> float:
    try:
        d = date.fromisoformat(chunk_date)
    except Exception:
        return RECENCY_FLOOR
    age = max((today - d).days, 0)
    w = 0.5 ** (age / RECENCY_HALF_LIFE)
    return max(w, RECENCY_FLOOR)


def search(query: str, k: int = 5):
    if not DB_PATH.exists():
        print("[search] no index — run: python index_memory.py", file=sys.stderr)
        return []

    embedder = get_embedder()
    con = _open()
    backend = con.execute("SELECT value FROM meta WHERE key='embed_backend'").fetchone()
    con.close()
    if backend and backend[0] != embedder.name:
        print(f"[search] WARNING: index built with '{backend[0]}' but active embedder is "
              f"'{embedder.name}'. Re-run: python index_memory.py --rebuild", file=sys.stderr)

    qvec = embedder.encode([query])[0].astype(np.float32)

    # --- the two channels run concurrently ---
    with ThreadPoolExecutor(max_workers=2) as ex:
        fv = ex.submit(vector_search, qvec, POOL)
        fk = ex.submit(keyword_search, query, POOL)
        vhits, khits = fv.result(), fk.result()

    # --- fuse by rank (RRF), tracking per-channel provenance ---
    vscore = _rrf([cid for cid, _ in vhits])
    kscore = _rrf([cid for cid, _ in khits])
    fused = {}
    for cid in set(vscore) | set(kscore):
        fused[cid] = vscore.get(cid, 0.0) + kscore.get(cid, 0.0)

    if not fused:
        return []

    # --- rerank by recency * source weight ---
    con = _open()
    meta = {r[0]: r for r in con.execute(
        "SELECT id, source, date, heading, turn_hash, text FROM chunks "
        f"WHERE id IN ({','.join('?' * len(fused))})", tuple(fused))}
    con.close()

    today = date.today()
    results = []
    for cid, fscore in fused.items():
        _, source, cdate, heading, turn, text = meta[cid]
        rw = recency_weight(cdate, today)
        sw = source_weight(source, heading)
        final = fscore * rw * sw
        results.append({
            "id": cid, "final": final, "rrf": fscore, "recency": rw, "src_w": sw,
            "in_vec": cid in vscore, "in_kw": cid in kscore,
            "source": source, "date": cdate, "heading": heading, "turn": turn,
            "citation": _citation(source, cdate, heading, turn),
            "text": text,
        })
    results.sort(key=lambda r: -r["final"])
    return results[:k]


def _fmt(r: dict, full: bool = False) -> str:
    chans = ("V" if r["in_vec"] else "-") + ("K" if r["in_kw"] else "-")
    if full:
        body = "\n".join("    " + ln for ln in r["text"].strip().splitlines())
    else:
        snippet = " ".join(r["text"].split())
        if len(snippet) > 200:
            snippet = snippet[:200] + "…"
        body = "    " + snippet
    return (
        f"● {r['final']:.4f}  [{chans}]  {r['citation']}\n"
        f"    rrf={r['rrf']:.4f} recency={r['recency']:.2f} src_w={r['src_w']:.2f}\n"
        f"{body}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Hybrid search over the memory vector DB.")
    ap.add_argument("query", nargs="+", help="search text")
    ap.add_argument("--k", type=int, default=5, help="number of results (default 5)")
    ap.add_argument("--half-life", type=float, default=None,
                    help="recency half-life in days (default %(default)s)")
    ap.add_argument("--full", action="store_true",
                    help="print each chunk's full content (untruncated), for quoting")
    ap.add_argument("--json", action="store_true",
                    help="emit structured results (citation + provenance + full content)")
    args = ap.parse_args()
    if args.half_life:
        RECENCY_HALF_LIFE = args.half_life
    q = " ".join(args.query)
    hits = search(q, k=args.k)

    if args.json:
        fields = ("citation", "source", "date", "heading", "turn",
                  "final", "rrf", "recency", "src_w", "in_vec", "in_kw", "text")
        payload = {"query": q, "results": [{k: h[k] for k in fields} for h in hits]}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif not hits:
        print("(no matches)")
    else:
        print(f'query: "{q}"   [V]=vector [K]=keyword\n')
        for h in hits:
            print(_fmt(h, full=args.full))
            print()
