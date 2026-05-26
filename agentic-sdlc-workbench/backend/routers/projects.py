"""Project CRUD and member management endpoints."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class ProjectCreate(BaseModel):
    client_id: str
    project_code: str
    project_name: str
    description: Optional[str] = None
    status: str = "active"
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class ProjectUpdate(BaseModel):
    project_name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class MemberAdd(BaseModel):
    user_id: str
    role: str = "member"


@router.get("/projects")
async def list_projects(
    client_id: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    sql = (
        "SELECT p.*, c.client_name, "
        "(SELECT COUNT(*) FROM project_member pm WHERE pm.project_id = p.id AND pm.active = true) AS member_count "
        "FROM project p JOIN client c ON p.client_id = c.id "
    )
    params = {}
    if client_id:
        sql += "WHERE p.client_id = :client_id "
        params["client_id"] = client_id
    sql += "ORDER BY p.created_at DESC"
    r = await session.execute(text(sql), params)
    return [dict(row) for row in r.mappings().all()]


@router.post("/projects", status_code=201)
async def create_project(body: ProjectCreate, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "INSERT INTO project (client_id, project_code, project_name, description, status, start_date, end_date) "
            "VALUES (:client_id, :project_code, :project_name, :description, :status, :start_date, :end_date) "
            "RETURNING *"
        ),
        body.model_dump(),
    )
    await session.commit()
    return dict(r.mappings().first())


@router.get("/projects/{project_id}")
async def get_project(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT p.*, c.client_name FROM project p "
            "JOIN client c ON p.client_id = c.id "
            "WHERE p.id = :pid"
        ),
        {"pid": project_id},
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    project = dict(row)

    # Members
    rm = await session.execute(
        text(
            "SELECT pm.*, u.display_name, u.email FROM project_member pm "
            "JOIN asdlc_user u ON pm.user_id = u.id "
            "WHERE pm.project_id = :pid AND pm.active = true"
        ),
        {"pid": project_id},
    )
    project["members"] = [dict(r) for r in rm.mappings().all()]
    return project


@router.put("/projects/{project_id}")
async def update_project(
    project_id: str,
    body: ProjectUpdate,
    session: AsyncSession = Depends(get_db),
):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["pid"] = project_id
    r = await session.execute(
        text(f"UPDATE project SET {set_clause} WHERE id = :pid RETURNING *"),
        updates,
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return dict(row)


@router.get("/projects/{project_id}/members")
async def list_members(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT pm.*, u.display_name, u.email FROM project_member pm "
            "JOIN asdlc_user u ON pm.user_id = u.id "
            "WHERE pm.project_id = :pid AND pm.active = true"
        ),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


@router.post("/projects/{project_id}/members", status_code=201)
async def add_member(
    project_id: str,
    body: MemberAdd,
    session: AsyncSession = Depends(get_db),
):
    r = await session.execute(
        text(
            "INSERT INTO project_member (project_id, user_id, role) "
            "VALUES (:project_id, :user_id, :role) "
            "ON CONFLICT (project_id, user_id) DO UPDATE SET active = true, role = EXCLUDED.role "
            "RETURNING *"
        ),
        {"project_id": project_id, "user_id": body.user_id, "role": body.role},
    )
    await session.commit()
    return dict(r.mappings().first())


@router.delete("/projects/{project_id}/members/{member_id}", status_code=200)
async def remove_member(
    project_id: str,
    member_id: str,
    session: AsyncSession = Depends(get_db),
):
    await session.execute(
        text(
            "UPDATE project_member SET active = false "
            "WHERE id = :mid AND project_id = :pid"
        ),
        {"mid": member_id, "pid": project_id},
    )
    await session.commit()
    return {"detail": "Member removed"}
