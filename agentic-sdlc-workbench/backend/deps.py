"""FastAPI dependencies: get_db(), get_current_user_id()"""
from contextvars import ContextVar
from typing import AsyncGenerator

from fastapi import Request, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, current_user_id_var

# Re-export so routers can import from deps
__all__ = ["get_db", "get_current_user_id", "current_user_id_var"]


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """Dependency that yields an AsyncSession with current_user_id set."""
    user_id = request.headers.get("X-User-ID", "")
    token = current_user_id_var.set(user_id)
    async with AsyncSessionLocal() as session:
        if user_id:
            await session.execute(
                text("SET LOCAL app.current_user_id = :uid"), {"uid": user_id}
            )
        try:
            yield session
        finally:
            current_user_id_var.reset(token)
            await session.close()


def get_current_user_id(request: Request) -> str:
    """Returns X-User-ID header value or raises 401."""
    user_id = request.headers.get("X-User-ID")
    if not user_id:
        raise HTTPException(status_code=401, detail="X-User-ID header required")
    return user_id
