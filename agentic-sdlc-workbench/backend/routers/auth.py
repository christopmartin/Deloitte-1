"""Auth / user management endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from deps import get_db

router = APIRouter()


@router.get("/users")
async def list_users(session: AsyncSession = Depends(get_db)):
    result = await session.execute(
        text(
            "SELECT id, display_name, email, role, active "
            "FROM asdlc_user ORDER BY display_name"
        )
    )
    rows = result.mappings().all()
    return [dict(r) for r in rows]


@router.get("/users/{user_id}")
async def get_user(user_id: str, session: AsyncSession = Depends(get_db)):
    result = await session.execute(
        text(
            "SELECT id, display_name, email, role, active "
            "FROM asdlc_user WHERE id = :uid"
        ),
        {"uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)
