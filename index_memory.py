#!/usr/bin/env python3
"""Index the dated memory logs into a local embedded vector DB (SQLite).

Chunks each memory/daily/<date>.md by natural section breaks (markdown headings and
`<!-- turn:HASH -->` markers), embeds every chunk, and stores it with metadata
(source file, date, heading, turn hash, ordinal) in memory/memory_index.db — alongside
an FTS5 full-text index for the keyword channel used by search_memory.py.

Incremental by default (skips files whose mtime is unchanged); `--rebuild` starts fresh.

    python index_memory.py            # incremental
    python index_memory.py --rebuild  # drop & rebuild everything
    python index_memory.py --stats    # show what's indexed
"""
import os
import re
import sys
import time
import json
import sqlite3
import hashlib
from pathlib import Path
from datetime import date

import numpy as np

from memory_embedder import get_embedder

try:  # Windows consoles default to cp1252, which chokes on em-dashes in status lines
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Per-project mode: this copy lives at the project root itself (not one level below a
# shared parent), so SCAN_ROOT is this project only — logs from other projects are never
# scanned. DB lives inside this project's own memory/ folder (gitignored).
SCAN_ROOT = Path(os.environ.get("MEMORY_SCAN_ROOT", Path(__file__).resolve().parent))
DB_PATH = Path(os.environ.get("MEMORY_DB", SCAN_ROOT / "memory" / "memory_index.db"))
DAILY_GLOB = "**/memory/daily/*.md"       # every folder's dated logs, recursively
EXCLUDE_PARTS = {".session-memory", "_TO_DELETE", "transcript-archive", ".claude"}

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
TURN_RE = re.compile(r"^<!--\s*turn:([0-9a-f]+)\s*-->")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
MAX_CHUNK_CHARS = 1500  # oversized sections get split on blank lines


def _date_from_name(path: Path) -> str:
    m = DATE_RE.search(path.name)
    return m.group(1) if m else ""


def chunk_markdown(text: str):
    """Yield (heading, turn_hash, ordinal, chunk_text) split on natural breaks.

    A new chunk begins at any markdown heading or any `<!-- turn: -->` marker. The
    'heading' carried on each chunk is the nearest preceding markdown heading (so turn
    entries inherit the section they live under); a heading line starts its own chunk.
    """
    lines = text.splitlines()
    cur_heading = ""
    blocks = []          # (heading, turn_hash, [lines])
    buf, buf_heading, buf_turn = [], "", ""

    def flush():
        if any(ln.strip() for ln in buf):
            blocks.append((buf_heading, buf_turn, list(buf)))

    for ln in lines:
        hm = HEADING_RE.match(ln)
        tm = TURN_RE.match(ln)
        if hm or tm:
            flush()
            buf = [ln]
            if hm:
                cur_heading = hm.group(2).strip()
                buf_heading, buf_turn = cur_heading, ""
            else:
                buf_heading, buf_turn = cur_heading, tm.group(1)
        else:
            if not buf:
                buf_heading, buf_turn = cur_heading, ""
            buf.append(ln)
    flush()

    ordinal = 0
    for heading, turn, blk in blocks:
        chunk = "\n".join(blk).strip()
        if not chunk:
            continue
        # Split an oversized section on blank lines, keeping heading/turn metadata.
        if len(chunk) <= MAX_CHUNK_CHARS:
            pieces = [chunk]
        else:
            pieces, acc = [], []
            for para in re.split(r"\n\s*\n", chunk):
                if acc and sum(len(p) for p in acc) + len(para) > MAX_CHUNK_CHARS:
                    pieces.append("\n\n".join(acc)); acc = []
                acc.append(para)
            if acc:
                pieces.append("\n\n".join(acc))
        for p in pieces:
            yield heading, turn, ordinal, p
            ordinal += 1


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db_path))
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS files(
            path TEXT PRIMARY KEY, mtime REAL, indexed_at REAL, n_chunks INTEGER);
        CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY,
            source TEXT, date TEXT, heading TEXT, turn_hash TEXT, ord INTEGER,
            text TEXT, content_hash TEXT, embedding BLOB);
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, heading, source);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        """
    )
    return con


def _get_meta(con, key, default=None):
    row = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def _set_meta(con, key, value):
    con.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def _delete_file(con, rel: str):
    ids = [r[0] for r in con.execute("SELECT id FROM chunks WHERE source=?", (rel,))]
    for cid in ids:
        con.execute("DELETE FROM chunks_fts WHERE rowid=?", (cid,))
    con.execute("DELETE FROM chunks WHERE source=?", (rel,))
    con.execute("DELETE FROM files WHERE path=?", (rel,))


def index(rebuild: bool = False) -> None:
    embedder = get_embedder()
    if rebuild and DB_PATH.exists():
        DB_PATH.unlink()
    con = connect(DB_PATH)

    # Guard against mixing embedding spaces in one DB.
    built_backend = _get_meta(con, "embed_backend")
    built_dim = _get_meta(con, "embed_dim")
    if built_backend and (built_backend != embedder.name or int(built_dim) != embedder.dim):
        print(f"[index] embedder changed ({built_backend}/{built_dim} -> "
              f"{embedder.name}/{embedder.dim}); rebuilding.", file=sys.stderr)
        con.close()
        DB_PATH.unlink()
        con = connect(DB_PATH)
    _set_meta(con, "embed_backend", embedder.name)
    _set_meta(con, "embed_dim", embedder.dim)

    files = sorted(
        p for p in SCAN_ROOT.glob(DAILY_GLOB) if not (set(p.parts) & EXCLUDE_PARTS)
    )
    if not files:
        print(f"[index] no files match {DAILY_GLOB} under {SCAN_ROOT}", file=sys.stderr)

    total_chunks = 0
    changed = 0
    for path in files:
        rel = path.relative_to(SCAN_ROOT).as_posix()  # e.g. "Legal/memory/daily/2026-07-12.md"
        mtime = path.stat().st_mtime
        prev = con.execute("SELECT mtime FROM files WHERE path=?", (rel,)).fetchone()
        if prev and abs(prev[0] - mtime) < 1e-6:
            total_chunks += con.execute(
                "SELECT COUNT(*) FROM chunks WHERE source=?", (rel,)).fetchone()[0]
            continue  # unchanged — incremental skip

        changed += 1
        _delete_file(con, rel)
        text = path.read_text(encoding="utf-8")
        fdate = _date_from_name(path)

        rows = list(chunk_markdown(text))
        if rows:
            vecs = embedder.encode([c[3] for c in rows])
        else:
            vecs = np.zeros((0, embedder.dim), dtype=np.float32)

        n = 0
        for (heading, turn, ordinal, chunk), vec in zip(rows, vecs):
            chash = hashlib.sha1(chunk.encode("utf-8")).hexdigest()
            cur = con.execute(
                "INSERT INTO chunks(source,date,heading,turn_hash,ord,text,content_hash,embedding)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (rel, fdate, heading, turn, ordinal, chunk, chash,
                 vec.astype(np.float32).tobytes()),
            )
            con.execute(
                "INSERT INTO chunks_fts(rowid,text,heading,source) VALUES(?,?,?,?)",
                (cur.lastrowid, chunk, heading, rel),
            )
            n += 1
        con.execute(
            "INSERT INTO files(path,mtime,indexed_at,n_chunks) VALUES(?,?,?,?)"
            " ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,"
            " indexed_at=excluded.indexed_at, n_chunks=excluded.n_chunks",
            (rel, mtime, time.time(), n),
        )
        total_chunks += n
        print(f"[index] {rel}: {n} chunks")

    # Prune entries for logs that have vanished from disk (deleted folders, moved files).
    # Without this, incremental runs would leave stale chunks searchable forever.
    current = {path.relative_to(SCAN_ROOT).as_posix() for path in files}
    pruned = 0
    for (dbpath,) in con.execute("SELECT path FROM files").fetchall():
        if dbpath not in current:
            _delete_file(con, dbpath)
            pruned += 1
            print(f"[index] pruned {dbpath} (gone from disk)")

    con.commit()
    con.close()
    print(f"[index] done — backend={embedder.name} dim={embedder.dim} "
          f"files={len(files)} changed={changed} chunks={total_chunks} db={DB_PATH.name}")


def stats() -> None:
    if not DB_PATH.exists():
        print("[stats] no index yet — run: python index_memory.py")
        return
    con = connect(DB_PATH)
    backend = _get_meta(con, "embed_backend")
    dim = _get_meta(con, "embed_dim")
    nfiles = con.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    nchunks = con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    print(f"[stats] backend={backend} dim={dim} files={nfiles} chunks={nchunks}")
    for path, n, ts in con.execute(
            "SELECT path,n_chunks,indexed_at FROM files ORDER BY path"):
        print(f"        {path}: {n} chunks")
    con.close()


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--stats" in args:
        stats()
    else:
        index(rebuild="--rebuild" in args)
