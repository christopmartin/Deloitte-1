#!/usr/bin/env python3
"""Pluggable text embedder shared by index_memory.py and search_memory.py.

Backend selection (first that works wins; override with MEMORY_EMBED_BACKEND):

  sentence-transformers  — real semantic embeddings, if the package is installed.
  openai                 — OpenAI embeddings, if OPENAI_API_KEY is set.
  hashing                — dependency-free local fallback (numpy only). Deterministic,
                           offline, no downloads. Semantically weak but a genuine dense
                           vector space, so all the vector-search plumbing is real and
                           it upgrades transparently once a stronger backend is present.

Every backend returns L2-normalized float32 rows, so cosine similarity == dot product.
The index records which backend + dim it was built with; search refuses to mix them.
"""
import os
import re
import hashlib
import numpy as np

# Keep the optional model2vec/HuggingFace backend quiet so it never pollutes
# search output or the detached Stop-hook worker. Set before those libs import.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

EMBED_DIM_HASHING = 512  # dimensionality of the local fallback


# --------------------------------------------------------------------------
# Local, dependency-free fallback: signed char-n-gram + word hashing.
# --------------------------------------------------------------------------
_WORD_RE = re.compile(r"[a-z0-9_]+")


def _tokens(text: str):
    text = text.lower()
    words = _WORD_RE.findall(text)
    toks = list(words)
    for w in words:
        padded = f"#{w}#"
        for n in (3, 4, 5):
            if len(padded) >= n:
                toks.extend(padded[i:i + n] for i in range(len(padded) - n + 1))
    return toks


class HashingEmbedder:
    name = "hashing"

    def __init__(self, dim: int = EMBED_DIM_HASHING):
        self.dim = dim

    def encode(self, texts):
        m = np.zeros((len(texts), self.dim), dtype=np.float32)
        for r, t in enumerate(texts):
            for tok in _tokens(t):
                h = int.from_bytes(hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest(), "little")
                idx = h % self.dim
                sign = 1.0 if (h >> 63) & 1 else -1.0  # signed hashing curbs collisions
                m[r, idx] += sign
        # sublinear damping so a few colliding tokens don't dominate
        m = np.sign(m) * np.log1p(np.abs(m))
        norms = np.linalg.norm(m, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return (m / norms).astype(np.float32)


# --------------------------------------------------------------------------
# Optional stronger backends (used automatically when available).
# --------------------------------------------------------------------------
class Model2VecEmbedder:
    """Distilled STATIC embeddings — genuinely semantic, numpy-only, no torch.

    Ideal for this machine (Python 3.14, x86-on-ARM) where torch has no usable wheel.
    The model (~30 MB) downloads once from HuggingFace and is then served from cache.
    """
    name = "model2vec"

    def __init__(self, model="minishlab/potion-base-8M"):
        from model2vec import StaticModel  # noqa
        self._m = StaticModel.from_pretrained(model)
        probe = np.asarray(self._m.encode(["x"]), dtype=np.float32)
        self.dim = int(probe.shape[1])
        self.name = f"model2vec:{model}"

    def encode(self, texts):
        v = np.asarray(self._m.encode(list(texts)), dtype=np.float32)
        n = np.linalg.norm(v, axis=1, keepdims=True)
        n[n == 0] = 1.0
        return (v / n).astype(np.float32)


class SentenceTransformerEmbedder:
    name = "sentence-transformers"

    def __init__(self, model="all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer  # noqa
        self._m = SentenceTransformer(model)
        self.dim = self._m.get_sentence_embedding_dimension()
        self.name = f"sentence-transformers:{model}"

    def encode(self, texts):
        v = self._m.encode(list(texts), normalize_embeddings=True, convert_to_numpy=True)
        return v.astype(np.float32)


class OpenAIEmbedder:
    name = "openai"

    def __init__(self, model="text-embedding-3-small"):
        from openai import OpenAI  # noqa
        self._c = OpenAI()
        self._model = model
        self.dim = 1536
        self.name = f"openai:{model}"

    def encode(self, texts):
        resp = self._c.embeddings.create(model=self._model, input=list(texts))
        v = np.array([d.embedding for d in resp.data], dtype=np.float32)
        n = np.linalg.norm(v, axis=1, keepdims=True)
        n[n == 0] = 1.0
        return v / n


def get_embedder():
    """Return an embedder with .name, .dim, .encode(list[str]) -> (n, dim) float32."""
    pick = os.environ.get("MEMORY_EMBED_BACKEND", "auto").lower()

    def _try(order):
        for want in order:
            try:
                if want == "sentence-transformers":
                    return SentenceTransformerEmbedder()
                if want == "model2vec":
                    return Model2VecEmbedder()
                if want == "openai" and os.environ.get("OPENAI_API_KEY"):
                    return OpenAIEmbedder()
                if want == "hashing":
                    return HashingEmbedder()
            except Exception:
                continue
        return HashingEmbedder()

    if pick in ("hashing", "model2vec", "sentence-transformers", "openai"):
        return _try([pick, "hashing"])
    return _try(["sentence-transformers", "model2vec", "openai", "hashing"])


if __name__ == "__main__":
    e = get_embedder()
    v = e.encode(["double dip entry logic", "the cat sat"])
    print(f"backend={e.name} dim={e.dim} shape={v.shape} "
          f"self-sim={float(v[0] @ v[0]):.3f} cross={float(v[0] @ v[1]):.3f}")
