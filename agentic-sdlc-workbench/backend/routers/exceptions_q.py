"""Exception queue endpoints."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class ExceptionCreate(BaseModel):
    project_id: str
    exception_type: str
    title: str
    description: Optional[str] = None
    status: str = "open"
    assigned_member_id: Optional[str] = None
    related_record_id: Optional[str] = None
    related_table: Optional[str] = None


class ExceptionUpdate(BaseModel):
    status: Optional[str] = None
    assigned_member_id: Optional[str] = None
    resolution_notes: Optional[str] = None
    resolved_at: Optional[str] = None


@router.get("/exceptions/summary")
async def exceptions_summary(
    project_id: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = (
        "SELECT exception_type, COUNT(*) AS count "
        "FROM exception_queue WHERE 1=1 "
    )
    params = {}
    if project_id:
        sql += "AND project_id = :project_id "
        params["project_id"] = project_id
    sql += "GROUP BY exception_type ORDER BY exception_type"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/exceptions")
async def list_exceptions(
    project_id: Optional[str] = Query(None),
    exception_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = "SELECT * FROM exception_queue WHERE 1=1 "
    params = {}
    if project_id:
        sql += "AND project_id = :project_id "
        params["project_id"] = project_id
    if exception_type:
        sql += "AND exception_type = :exception_type "
        params["exception_type"] = exception_type
    if status:
        sql += "AND status = :status "
        params["status"] = status
    sql += "ORDER BY created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/exceptions/{ex_id}")
async def get_exception(ex_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text("SELECT * FROM exception_queue WHERE id = :eid"), {"eid": ex_id}
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Exception not found")
    return dict(row)


@router.post("/exceptions", status_code=201)
async def create_exception(
    body: ExceptionCreate, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text(
            "INSERT INTO exception_queue (project_id, exception_type, title, description, "
            "status, assigned_member_id, related_record_id, related_table) "
            "VALUES (:project_id, :exception_type, :title, :description, "
            ":status, :assigned_member_id, :related_record_id, :related_table) RETURNING *"
        ),
        body.model_dump(),
    )
    await session.commit()
    return dict(r.mappings().first())


@router.put("/exceptions/{ex_id}")
async def update_exception(
    ex_id: str,
    body: ExceptionUpdate,
    session: AsyncSession = Depends(get_db),
):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["eid"] = ex_id
    r = await session.execute(
        text(
            f"UPDATE exception_queue SET {set_clause} WHERE id = :eid RETURNING *"
        ),
        updates,
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Exception not found")
    return dict(row)
