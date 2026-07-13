#!/usr/bin/env python3
"""One-time backfill: import existing Claude Code session history into the memory logs.

The Stop hook only captures the *last* exchange each time a session stops, and it only
started running once it was wired up — so every turn before then is missing. This script
walks the raw session transcripts Claude Code keeps on disk, pulls out **every**
meaningful user/assistant exchange (using the exact same rules as the Stop hook), and
writes each one into the `memory/daily/<date>.md` format — dated to when the turn
happened, not today. Then it refreshes the shared search index.

Global model (matches the live hooks): each exchange is routed into **the folder its
session actually ran in** — read from the transcript's own `cwd` — not into one central
pile. So a past `Legal` session backfills into `Legal/memory/daily/`. Only sessions whose
folder sits under the CoWork Main Folder (the scan root) are imported.

It reuses the Stop hook's own primitives (`_is_genuine_prompt`, `summarize`,
`reindex_memory`, the section header and turn-hash convention) so imported entries are
indistinguishable from ones the hook writes live, and the shared turn-hash keeps it
idempotent: a turn the hook already logged is skipped, and re-running never duplicates.

Guarded by a sentinel file so it only runs once:

    python import_history.py              # backfill all CoWork folders, routed by session
    python import_history.py --dry-run    # list what would be written, per folder; write nothing
    python import_history.py --no-model   # heuristic one-liners only (fast, free)
    python import_history.py --limit 20   # cap exchanges (trial run)
    python import_history.py --force      # ignore the sentinel and run again
"""
import os
import sys
import json
import hashlib
import argparse
from pathlib import Path
from datetime import datetime
from collections import Counter

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR", Path(__file__).resolve().parent))
SCRIPT_DIR = Path(__file__).resolve().parent  # the hook module always lives beside us

# ---- Reuse the Stop hook's own logic so the format is identical -----------
sys.path.insert(0, str(SCRIPT_DIR / ".claude" / "hooks"))
import stop_capture as sc  # noqa: E402  (_text_of, _is_*, summarize, reindex_memory, …)

try:  # Windows consoles default to cp1252, which chokes on — … › in transcript text
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---- Editable knobs -------------------------------------------------------
PROJECTS_DIR = Path.home() / ".claude" / "projects"   # where CC stores transcripts
# The CoWork Main Folder: only sessions under here are imported (matches the indexer).
SCAN_ROOT = Path(os.environ.get("MEMORY_SCAN_ROOT", SCRIPT_DIR.parent)).resolve()
EXCLUDE_PARTS = {".session-memory", "_TO_DELETE", "transcript-archive", ".claude"}
SENTINEL = ROOT / "memory" / ".history-imported"       # run-once guard (lives with this project)
# ---------------------------------------------------------------------------


def transcript_files() -> list[Path]:
    """Every session transcript on disk. Placement is decided later by each session's
    own cwd, so we always read them all and route afterward."""
    if not PROJECTS_DIR.is_dir():
        return []
    return sorted(f for d in PROJECTS_DIR.iterdir() if d.is_dir() for f in d.glob("*.jsonl"))


def read_rows(path: Path) -> list:
    rows = []
    for ln in path.read_text(encoding="utf-8", errors="replace").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            rows.append(json.loads(ln))
        except Exception:
            continue  # skip any malformed line, keep going
    return rows


def extract_all_exchanges(rows: list) -> list[dict]:
    """Every genuine user prompt paired with the assistant text that followed it.

    Same filters the Stop hook's `extract_last_exchange` uses (skip meta/sidechain,
    tool-result-only user turns, and slash-command/stdout echoes) — plus a skip for the
    hook's own summarizer sessions — applied to every prompt, not just the last one.
    Each exchange also carries the record's `cwd`, which decides where it gets filed."""
    idxs = []
    for i, o in enumerate(rows):
        if o.get("type") != "user" or o.get("isMeta") or o.get("isSidechain"):
            continue
        content = o.get("message", {}).get("content")
        if sc._is_tool_result(content):
            continue
        text = sc._text_of(content)
        if text.lstrip().startswith(sc.SUMMARY_INSTRUCTION[:60]):
            continue  # the Stop hook's own `claude -p` summarizer session — not a real turn
        if sc._is_genuine_prompt(text):
            idxs.append(i)

    out = []
    for n, i in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(rows)
        u = rows[i]
        user_text = sc._text_of(u.get("message", {}).get("content")).strip()
        parts = [
            sc._text_of(o.get("message", {}).get("content"))
            for o in rows[i + 1:end]
            if o.get("type") == "assistant"
        ]
        assistant_text = "\n".join(p for p in parts if p.strip()).strip()
        if not user_text or not assistant_text:
            continue  # need both sides for a meaningful entry
        out.append({
            "uuid": u.get("uuid", ""),
            "ts": u.get("timestamp", ""),
            "cwd": u.get("cwd", ""),
            "user": user_text,
            "assistant": assistant_text,
        })
    return out


def _local_dt(ts: str):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except Exception:
        return None


def dest_root_for(cwd: str) -> Path | None:
    """The folder an exchange belongs in, or None if it's outside the CoWork scan root
    (or in an excluded area). Routing by the session's own cwd is what makes each folder
    get its own logs under the global model."""
    if not cwd:
        return None
    root = Path(cwd).resolve()
    if root != SCAN_ROOT and not root.is_relative_to(SCAN_ROOT):
        return None  # session ran outside the CoWork Main Folder — out of scope
    if set(root.parts) & EXCLUDE_PARTS:
        return None
    return root


def heuristic_summary(user_text: str) -> str:
    """The Stop hook's own fallback shape, for --no-model runs."""
    u = " ".join(user_text.split())[:200]
    return f"- Chris: {u}\n- (Imported from session history; raw transcript on disk.)"


def append_dated(dest_root: Path, day: str, hhmm: str, turn_hash: str, bullets: str) -> bool:
    """Idempotent append into <dest_root>/memory/daily/<day>.md, mirroring the Stop hook's
    writer but dated to the turn. Returns True if it wrote, False if already there."""
    daily_dir = dest_root / "memory" / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    path = daily_dir / f"{day}.md"
    existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    marker = f"<!-- turn:{turn_hash} -->"
    if marker in existing:
        return False

    chunk = f"\n{marker}\n**{hhmm}**\n{bullets}\n"
    parts = [existing.rstrip("\n")] if existing.strip() else []
    if not existing.strip():
        parts.append(f"# {day}")
    if sc.SECTION_HEADER not in existing:
        parts.append(
            "\n" + sc.SECTION_HEADER
            + "\n\n_Written automatically at each session stop. One entry per exchange; "
            "the source turn is hashed so re-runs never duplicate._"
        )
    parts.append(chunk)
    path.write_text("\n".join(parts).rstrip("\n") + "\n", encoding="utf-8")
    return True


def _label(dest_root: Path) -> str:
    """Short folder name for reporting, e.g. 'Legal' or 'Trading/TradingView-MCP'."""
    try:
        rel = dest_root.relative_to(SCAN_ROOT).as_posix()
        return rel or SCAN_ROOT.name
    except ValueError:
        return dest_root.name


def main() -> None:
    ap = argparse.ArgumentParser(description="One-time import of Claude Code session history.")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be written, per folder; change nothing")
    ap.add_argument("--no-model", action="store_true",
                    help="skip the summary model; write heuristic one-liners (fast/free)")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap the number of exchanges processed (for a trial run)")
    ap.add_argument("--force", action="store_true",
                    help="run even if the sentinel says the import already happened")
    args = ap.parse_args()

    if SENTINEL.exists() and not args.force:
        prior = SENTINEL.read_text(encoding="utf-8").strip().splitlines()[:1]
        print(f"[import] sentinel present ({SENTINEL.relative_to(ROOT).as_posix()}) — "
              f"already imported. Use --force to re-run.")
        if prior:
            print(f"[import] {prior[0]}")
        return

    files = transcript_files()
    if not files:
        print(f"[import] no transcripts found under {PROJECTS_DIR}", file=sys.stderr)
        return

    # Collect every exchange, tag with its date/time and its destination folder (from cwd).
    collected = []          # (ts_sort_key, day, hhmm, dest_root, exchange)
    out_of_scope = 0
    for f in files:
        fb_day = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d")
        for ex in extract_all_exchanges(read_rows(f)):
            dest = dest_root_for(ex["cwd"])
            if dest is None:
                out_of_scope += 1
                continue
            dt = _local_dt(ex["ts"])
            day = dt.strftime("%Y-%m-%d") if dt else fb_day
            hhmm = dt.strftime("%H:%M") if dt else "00:00"
            collected.append((ex["ts"] or "", day, hhmm, dest, ex))
    collected.sort(key=lambda t: (t[3].as_posix(), t[1], t[0]))  # by folder, day, time
    if args.limit:
        collected = collected[:args.limit]

    folders = sorted({_label(t[3]) for t in collected})
    print(f"[import] {len(files)} session file(s); {len(collected)} in-scope exchange(s) "
          f"across {len(folders)} folder(s); {out_of_scope} skipped as out-of-scope.")
    print(f"[import] folders: {', '.join(folders) if folders else '(none)'}")
    if not args.no_model and not args.dry_run:
        print(f"[import] summarizing with {sc.SUMMARY_MODEL} — up to {len(collected)} model "
              f"call(s). Use --no-model to skip, --dry-run to preview.")

    # Nested `claude -p` summary calls each fire their own Stop hook; set the recursion
    # guard so those return immediately instead of cascading (same as the live worker).
    env = dict(os.environ)
    env[sc.GUARD_ENV] = "1"

    wrote = Counter()
    written = skipped = 0
    for _, day, hhmm, dest, ex in collected:
        turn_hash = hashlib.sha1((ex["uuid"] + "\n" + ex["user"]).encode("utf-8")).hexdigest()[:12]

        # Pre-check the marker so we never pay for a summary of an already-logged turn.
        path = dest / "memory" / "daily" / f"{day}.md"
        if path.is_file() and f"<!-- turn:{turn_hash} -->" in path.read_text(encoding="utf-8"):
            skipped += 1
            continue

        if args.dry_run:
            preview = " ".join(ex["user"].split())[:55]
            print(f"[dry] {_label(dest):<24} {day} {hhmm}  {turn_hash}  {preview!r}")
            continue

        bullets = heuristic_summary(ex["user"]) if args.no_model \
            else sc.summarize(ex["user"], ex["assistant"], env)
        if append_dated(dest, day, hhmm, turn_hash, bullets):
            written += 1
            wrote[_label(dest)] += 1
        else:
            skipped += 1

    if args.dry_run:
        print(f"[import] dry run — {len(collected)} exchange(s) would be considered, nothing written.")
        return

    # Refresh the shared search index (central), then set the sentinel.
    try:
        sc.reindex_memory()
    except Exception as e:
        print(f"[import] reindex skipped: {type(e).__name__}: {e}", file=sys.stderr)

    SENTINEL.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    per_folder = ", ".join(f"{k}={v}" for k, v in sorted(wrote.items())) or "(none)"
    SENTINEL.write_text(
        f"imported {written} exchange(s) ({skipped} already present, {out_of_scope} out-of-scope) "
        f"at {stamp}\nby folder: {per_folder}\n",
        encoding="utf-8",
    )
    print(f"[import] done — wrote {written}, skipped {skipped} (already logged).")
    print(f"[import] by folder: {per_folder}")
    print(f"[import] sentinel: {SENTINEL.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
