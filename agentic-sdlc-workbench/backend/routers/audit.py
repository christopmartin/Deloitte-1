"""Audit log query endpoint."""
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from deps import get_db

router = APIRouter()


@router.get("/audit-log")
async def get_audit_log(
    table_name: Optional[str] = Query(None),
    record_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    session: AsyncSession = Depends(get_db),
):
    sql = (
        "SELECT id, table_name, record_id, operation, changed_at, changed_by, "
        "old_values, new_values "
        "FROM asdlc_audit_log WHERE 1=1 "
    )
    params: dict = {}
    if table_name:
        sql += "AND table_name = :table_name "
        params["table_name"] = table_name
    if record_id:
        sql += "AND record_id = :record_id "
        params["record_id"] = record_id
    sql += "ORDER BY changed_at DESC LIMIT :limit"
    params["limit"] = limit

    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]
