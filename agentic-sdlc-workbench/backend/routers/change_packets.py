"""Change packet CRUD and workflow action endpoints."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class CPCreate(BaseModel):
    project_id: str
    title: str
    description: Optional[str] = None
    risk_level: str = "low"
    conflict_classification: Optional[str] = None
    source_evidence_id: Optional[str] = None


class ApproveBody(BaseModel):
    approver_member_id: str


class LockBody(BaseModel):
    locked_by_member_id: str


@router.get("/change-packets")
async def list_change_packets(
    project_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    conflict_classification: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = (
        "SELECT cp.*, p.project_name, p.project_code, "
        "(SELECT COUNT(*) FROM change_packet_item cpi WHERE cpi.change_packet_id = cp.id) AS item_count "
        "FROM change_packet cp JOIN project p ON cp.project_id = p.id WHERE 1=1 "
    )
    params = {}
    if project_id:
        sql += "AND cp.project_id = :project_id "
        params["project_id"] = project_id
    if status:
        sql += "AND cp.status = :status "
        params["status"] = status
    if risk_level:
        sql += "AND cp.risk_level = :risk_level "
        params["risk_level"] = risk_level
    if conflict_classification:
        sql += "AND cp.conflict_classification = :conflict_classification "
        params["conflict_classification"] = conflict_classification
    sql += "ORDER BY cp.created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/change-packets/{cp_id}")
async def get_change_packet(cp_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT cp.*, p.project_name, p.project_code FROM change_packet cp "
            "JOIN project p ON cp.project_id = p.id WHERE cp.id = :cid"
        ),
        {"cid": cp_id},
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Change packet not found")
    cp = dict(row)

    ri = await session.execute(
        text("SELECT * FROM change_packet_item WHERE change_packet_id = :cid ORDER BY sort_order"),
        {"cid": cp_id},
    )
    cp["items"] = [dict(r) for r in ri.mappings().all()]
    return cp


@router.post("/change-packets", status_code=201)
async def create_change_packet(body: CPCreate, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "INSERT INTO change_packet (project_id, title, description, risk_level, "
            "conflict_classification, source_evidence_id) "
            "VALUES (:project_id, :title, :description, :risk_level, "
            ":conflict_classification, :source_evidence_id) RETURNING *"
        ),
        body.model_dump(),
    )
    await session.commit()
    return dict(r.mappings().first())


@router.post("/change-packets/{cp_id}/approve")
async def approve_cp(
    cp_id: str,
    body: ApproveBody,
    session: AsyncSession = Depends(get_db),
):
    r = await session.execute(
        text(
            "UPDATE change_packet SET status = 'approved', approval_timestamp = NOW(), "
            "approver_member_id = :approver_member_id "
            "WHERE id = :cid RETURNING *"
        ),
        {"cid": cp_id, "approver_member_id": body.approver_member_id},
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Change packet not found")
    return dict(row)


@router.post("/change-packets/{cp_id}/reject")
async def reject_cp(cp_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "UPDATE change_packet SET status = 'rejected' WHERE id = :cid RETURNING *"
        ),
        {"cid": cp_id},
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Change packet not found")
    return dict(row)


@router.post("/change-packets/{cp_id}/send-back")
async def send_back_cp(cp_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "UPDATE change_packet SET status = 'sent_back' WHERE id = :cid RETURNING *"
        ),
        {"cid": cp_id},
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Change packet not found")
    return dict(row)


@router.post("/change-packets/{cp_id}/split", status_code=201)
async def split_cp(cp_id: str, session: AsyncSession = Depends(get_db)):
    # Fetch original
    r = await session.execute(
        text("SELECT * FROM change_packet WHERE id = :cid"), {"cid": cp_id}
    )
    orig = r.mappings().first()
    if not orig:
        raise HTTPException(status_code=404, detail="Change packet not found")
    orig = dict(orig)

    # Clone metadata into new CP
    r2 = await session.execute(
        text(
            "INSERT INTO change_packet (project_id, title, description, risk_level, "
            "conflict_classification, source_evidence_id) "
            "VALUES (:project_id, :title, :description, :risk_level, "
            ":conflict_classification, :source_evidence_id) RETURNING *"
        ),
        {
            "project_id": orig["project_id"],
            "title": f"[Split] {orig['title']}",
            "description": orig.get("description"),
            "risk_level": orig.get("risk_level", "low"),
            "conflict_classification": orig.get("conflict_classification"),
            "source_evidence_id": orig.get("source_evidence_id"),
        },
    )
    await session.commit()
    new_cp = dict(r2.mappings().first())
    return {"new_change_packet_id": new_cp["id"], "change_packet": new_cp}
