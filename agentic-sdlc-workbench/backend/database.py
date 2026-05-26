"""Async SQLAlchemy engine, session factory, and startup schema runner."""
import os
import glob
from contextvars import ContextVar
from pathlib import Path

import asyncpg
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://asdlc_app:asdlc_dev_password@localhost:5432/asdlc",
)

# Raw asyncpg URL (no driver prefix) for direct asyncpg usage
_ASYNCPG_URL = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)

# ContextVar so middleware can inject user_id per-request
current_user_id_var: ContextVar[str] = ContextVar("current_user_id", default="")

SQL_DIR = Path(__file__).parent / "sql"


async def run_sql_files() -> None:
    """Connect with raw asyncpg and execute each SQL migration file in order."""
    conn = await asyncpg.connect(_ASYNCPG_URL)
    try:
        sql_files = sorted(SQL_DIR.glob("*.sql"))
        for sql_file in sql_files:
            sql_text = sql_file.read_text(encoding="utf-8")
            # Execute idempotently — errors from IF NOT EXISTS etc. are suppressed
            try:
                await conn.execute(sql_text)
                print(f"[DB] Executed {sql_file.name}")
            except Exception as exc:
                print(f"[DB] Warning executing {sql_file.name}: {exc}")
    finally:
        await conn.close()


async def get_db(user_id: str = ""):
    """Yield an AsyncSession with SET LOCAL app.current_user_id applied."""
    async with AsyncSessionLocal() as session:
        uid = user_id or current_user_id_var.get("")
        if uid:
            from sqlalchemy import text
            await session.execute(
                text("SET LOCAL app.current_user_id = :uid"), {"uid": uid}
            )
        try:
            yield session
        finally:
            await session.close()
