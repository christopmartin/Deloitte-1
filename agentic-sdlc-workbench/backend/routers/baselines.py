"""Baseline CRUD and comparison endpoints."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class BaselineCreate(BaseModel):
    project_id: str
    baseline_name: str
    description: Optional[str] = None
    baseline_version: Optional[str] = None


class LockBody(BaseModel):
    locked_by_member_id: str


@router.get("/baselines")
async def list_baselines(
    project_id: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = (
        "SELECT b.*, "
        "(SELECT COUNT(*) FROM baseline_item bi WHERE bi.baseline_id = b.id) AS item_count "
        "FROM baseline b WHERE 1=1 "
    )
    params = {}
    if project_id:
        sql += "AND b.project_id = :project_id "
        params["project_id"] = project_id
    sql += "ORDER BY b.created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/baselines/{baseline_id}")
async def get_baseline(baseline_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text("SELECT * FROM baseline WHERE id = :bid"), {"bid": baseline_id}
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Baseline not found")
    baseline = dict(row)

    ri = await session.execute(
        text(
            "SELECT (SELECT COUNT(*) FROM baseline_item WHERE baseline_id = :bid) AS item_count"
        ),
        {"bid": baseline_id},
    )
    baseline["item_count"] = ri.scalar()
    return baseline


@router.post("/baselines", status_code=201)
async def create_baseline(body: BaselineCreate, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "INSERT INTO baseline (project_id, baseline_name, description, baseline_version) "
            "VALUES (:project_id, :baseline_name, :description, :baseline_version) "
            "RETURNING *"
        ),
        body.model_dump(),
    )
    await session.commit()
    return dict(r.mappings().first())


@router.post("/baselines/{baseline_id}/lock")
async def lock_baseline(
    baseline_id: str,
    body: LockBody,
    session: AsyncSession = Depends(get_db),
):
    r = await session.execute(
        text(
            "UPDATE baseline SET baseline_status = 'approved', locked_at = NOW(), "
            "locked_by_member_id = :locked_by_member_id "
            "WHERE id = :bid RETURNING *"
        ),
        {"bid": baseline_id, "locked_by_member_id": body.locked_by_member_id},
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Baseline not found")
    return dict(row)


@router.get("/baselines/{baseline_id}/compare/{other_id}")
async def compare_baselines(
    baseline_id: str,
    other_id: str,
    session: AsyncSession = Depends(get_db),
):
    # Items in baseline_id but not in other_id (added)
    r = await session.execute(
        text(
            "SELECT bi.* FROM baseline_item bi "
            "WHERE bi.baseline_id = :bid "
            "AND bi.record_id NOT IN ("
            "  SELECT record_id FROM baseline_item WHERE baseline_id = :oid"
            ")"
        ),
        {"bid": baseline_id, "oid": other_id},
    )
    added_records = [dict(row) for row in r.mappings().all()]

    # Items in other_id but not in baseline_id (removed)
    r = await session.execute(
        text(
            "SELECT bi.* FROM baseline_item bi "
            "WHERE bi.baseline_id = :oid "
            "AND bi.record_id NOT IN ("
            "  SELECT record_id FROM baseline_item WHERE baseline_id = :bid"
            ")"
        ),
        {"bid": baseline_id, "oid": other_id},
    )
    removed_records = [dict(row) for row in r.mappings().all()]

    # Items in both — check for field differences (content_hash or similar)
    r = await session.execute(
        text(
            "SELECT a.record_id, a.content_hash AS new_hash, b.content_hash AS old_hash "
            "FROM baseline_item a JOIN baseline_item b ON a.record_id = b.record_id "
            "WHERE a.baseline_id = :bid AND b.baseline_id = :oid "
            "AND a.content_hash IS DISTINCT FROM b.content_hash"
        ),
        {"bid": baseline_id, "oid": other_id},
    )
    modified_fields = [dict(row) for row in r.mappings().all()]

    # Change packets impacting baseline
    r = await session.execute(
        text(
            "SELECT cp.* FROM change_packet cp "
            "JOIN baseline b ON cp.project_id = b.project_id "
            "WHERE b.id = :bid AND cp.status NOT IN ('rejected','archived') "
            "AND cp.created_at > b.created_at"
        ),
        {"bid": baseline_id},
    )
    baseline_impacting_cps = [dict(row) for row in r.mappings().all()]

    return {
        "added_records": added_records,
        "modified_fields": modified_fields,
        "removed_records": removed_records,
        "baseline_impacting_cps": baseline_impacting_cps,
    }
