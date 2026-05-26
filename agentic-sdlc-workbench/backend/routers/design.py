"""Design content endpoints: use_cases, workflows, knowledge_articles, tools, hitl_gates, library."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class UseCaseCreate(BaseModel):
    title: str
    description: Optional[str] = None
    actor: Optional[str] = None
    preconditions: Optional[str] = None
    postconditions: Optional[str] = None
    status: str = "draft"


class WorkflowCreate(BaseModel):
    workflow_name: str
    description: Optional[str] = None
    status: str = "draft"


# ── Use Cases ──────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/use-cases")
async def list_use_cases(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text("SELECT * FROM use_case WHERE project_id = :pid ORDER BY created_at DESC"),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


@router.get("/projects/{project_id}/use-cases/{uc_id}")
async def get_use_case(
    project_id: str, uc_id: str, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text("SELECT * FROM use_case WHERE id = :uid AND project_id = :pid"),
        {"uid": uc_id, "pid": project_id},
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Use case not found")
    return dict(row)


@router.post("/projects/{project_id}/use-cases", status_code=201)
async def create_use_case(
    project_id: str,
    body: UseCaseCreate,
    session: AsyncSession = Depends(get_db),
):
    data = body.model_dump()
    data["project_id"] = project_id
    r = await session.execute(
        text(
            "INSERT INTO use_case (project_id, title, description, actor, "
            "preconditions, postconditions, status) "
            "VALUES (:project_id, :title, :description, :actor, "
            ":preconditions, :postconditions, :status) RETURNING *"
        ),
        data,
    )
    await session.commit()
    return dict(r.mappings().first())


# ── Workflows ──────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/workflows")
async def list_workflows(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text("SELECT * FROM workflow WHERE project_id = :pid ORDER BY created_at DESC"),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


@router.get("/projects/{project_id}/workflows/{wf_id}")
async def get_workflow(
    project_id: str, wf_id: str, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text("SELECT * FROM workflow WHERE id = :wid AND project_id = :pid"),
        {"wid": wf_id, "pid": project_id},
    )
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow not found")
    workflow = dict(row)

    rs = await session.execute(
        text(
            "SELECT * FROM workflow_step WHERE workflow_id = :wid ORDER BY step_order"
        ),
        {"wid": wf_id},
    )
    workflow["steps"] = [dict(r) for r in rs.mappings().all()]
    return workflow


# ── Knowledge Articles ─────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/knowledge-articles")
async def list_knowledge_articles(
    project_id: str, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text(
            "SELECT * FROM knowledge_article WHERE project_id = :pid ORDER BY created_at DESC"
        ),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


# ── Tools ──────────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/tools")
async def list_tools(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT * FROM tool_definition WHERE project_id = :pid ORDER BY created_at DESC"
        ),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


# ── HITL Gates ─────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/hitl-gates")
async def list_hitl_gates(project_id: str, session: AsyncSession = Depends(get_db)):
    r = await session.execute(
        text(
            "SELECT * FROM hitl_gate WHERE project_id = :pid ORDER BY created_at DESC"
        ),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


# ── Library ────────────────────────────────────────────────────────────────────

@router.get("/library")
async def get_library(
    scope: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    """All design content with visibility_scope=ALL_CLIENTS or CLIENT."""
    results = []

    # Filter by scope
    scope_filter = "AND visibility_scope = :scope" if scope else "AND visibility_scope IN ('ALL_CLIENTS','CLIENT')"
    scope_params: dict = {"scope": scope} if scope else {}

    if not type or type == "knowledge_article":
        sql = (
            f"SELECT id, 'knowledge_article' AS record_type, title, visibility_scope, "
            f"created_at, project_id FROM knowledge_article WHERE 1=1 {scope_filter}"
        )
        r = await session.execute(text(sql), scope_params)
        results.extend([dict(row) for row in r.mappings().all()])

    if not type or type == "hitl_gate":
        sql = (
            f"SELECT id, 'hitl_gate' AS record_type, gate_name AS title, visibility_scope, "
            f"created_at, project_id FROM hitl_gate WHERE 1=1 {scope_filter}"
        )
        r = await session.execute(text(sql), scope_params)
        results.extend([dict(row) for row in r.mappings().all()])

    if not type or type == "use_case":
        sql = (
            f"SELECT id, 'use_case' AS record_type, title, visibility_scope, "
            f"created_at, project_id FROM use_case WHERE 1=1 {scope_filter}"
        )
        r = await session.execute(text(sql), scope_params)
        results.extend([dict(row) for row in r.mappings().all()])

    if not type or type == "workflow":
        sql = (
            f"SELECT id, 'workflow' AS record_type, workflow_name AS title, visibility_scope, "
            f"created_at, project_id FROM workflow WHERE 1=1 {scope_filter}"
        )
        r = await session.execute(text(sql), scope_params)
        results.extend([dict(row) for row in r.mappings().all()])

    if not type or type == "tool":
        sql = (
            f"SELECT id, 'tool' AS record_type, tool_name AS title, visibility_scope, "
            f"created_at, project_id FROM tool_definition WHERE 1=1 {scope_filter}"
        )
        r = await session.execute(text(sql), scope_params)
        results.extend([dict(row) for row in r.mappings().all()])

    results.sort(key=lambda x: str(x.get("created_at", "")), reverse=True)
    return results
