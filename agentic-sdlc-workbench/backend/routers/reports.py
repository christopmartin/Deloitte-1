"""Report export endpoints."""
from typing import Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class ReportCreate(BaseModel):
    project_id: str
    report_type: str
    report_format: str = "pdf"
    title: Optional[str] = None
    filters: Optional[dict] = None


@router.get("/reports")
async def list_reports(
    project_id: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = "SELECT re.*, p.project_code FROM report_export re JOIN project p ON re.project_id = p.id WHERE 1=1 "
    params = {}
    if project_id:
        sql += "AND re.project_id = :project_id "
        params["project_id"] = project_id
    sql += "ORDER BY re.created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.get("/reports/{report_id}")
async def get_report(report_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT re.*, p.project_code FROM report_export re "
            "JOIN project p ON re.project_id = p.id WHERE re.id = :rid"
        ),
        {"rid": report_id},
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    return dict(row)


@router.post("/reports", status_code=201)
async def create_report(body: ReportCreate, session: AsyncSession = Depends(get_db)):
    # Fetch project code for stub URL
    r = await session.execute(
        text("SELECT project_code FROM project WHERE id = :pid"),
        {"pid": body.project_id},
    )
    row = r.mappings().first()
    project_code = row["project_code"] if row else "UNKNOWN"

    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    file_url = f"/exports/{project_code}-{body.report_type}-{timestamp}.{body.report_format}"
    title = body.title or f"{project_code} {body.report_type} {timestamp}"

    r2 = await session.execute(
        text(
            "INSERT INTO report_export (project_id, report_type, report_format, title, file_url) "
            "VALUES (:project_id, :report_type, :report_format, :title, :file_url) RETURNING *"
        ),
        {
            "project_id": body.project_id,
            "report_type": body.report_type,
            "report_format": body.report_format,
            "title": title,
            "file_url": file_url,
        },
    )
    await session.commit()
    return dict(r2.mappings().first())
