"""Evidence source endpoints."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class EvidenceCreate(BaseModel):
    project_id: str
    source_type: str
    source_name: str
    source_url: Optional[str] = None
    description: Optional[str] = None
    validation_status: str = "pending"
    collected_at: Optional[str] = None


class EvidenceUpdate(BaseModel):
    source_name: Optional[str] = None
    source_url: Optional[str] = None
    description: Optional[str] = None
    validation_status: Optional[str] = None
    collected_at: Optional[str] = None


@router.get("/evidence-sources")
async def list_evidence_sources(
    project_id: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    validation_status: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = "SELECT * FROM evidence_source WHERE 1=1 "
    params = {}
    if project_id:
        sql += "AND project_id = :project_id "
        params["project_id"] = project_id
    if source_type:
        sql += "AND source_type = :source_type "
        params["source_type"] = source_type
    if validation_status:
        sql += "AND validation_status = :validation_status "
        params["validation_status"] = validation_status
    sql += "ORDER BY created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/evidence-sources/{ev_id}")
async def get_evidence_source(ev_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text("SELECT * FROM evidence_source WHERE id = :eid"), {"eid": ev_id}
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Evidence source not found")
    return dict(row)


@router.post("/evidence-sources", status_code=201)
async def create_evidence_source(
    body: EvidenceCreate, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text(
            "INSERT INTO evidence_source (project_id, source_type, source_name, source_url, "
            "description, validation_status, collected_at) "
            "VALUES (:project_id, :source_type, :source_name, :source_url, "
            ":description, :validation_status, :collected_at) RETURNING *"
        ),
        body.model_dump(),
    )
    await session.commit()
    return dict(r.mappings().first())


@router.put("/evidence-sources/{ev_id}")
async def update_evidence_source(
    ev_id: str,
    body: EvidenceUpdate,
    session: AsyncSession = Depends(get_db),
):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["eid"] = ev_id
    r = await session.execute(
        text(f"UPDATE evidence_source SET {set_clause} WHERE id = :eid RETURNING *"),
        updates,
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Evidence source not found")
    return dict(row)


@router.get("/evidence-sources/{ev_id}/linked-items")
async def get_linked_items(ev_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT cpi.*, cp.title AS change_packet_title "
            "FROM change_packet_item cpi "
            "JOIN change_packet cp ON cpi.change_packet_id = cp.id "
            "WHERE cp.source_evidence_id = :eid"
        ),
        {"eid": ev_id},
    )
    items = [dict(row) for row in r.mappings().all()]
    return {"count": len(items), "items": items}
