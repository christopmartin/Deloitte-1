"""Agent settings endpoints per project."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from deps import get_db

router = APIRouter()


class AgentSettingUpdate(BaseModel):
    trust_level: Optional[str] = None
    enabled: Optional[bool] = None
    requires_human_approval: Optional[bool] = None
    notes: Optional[str] = None


@router.get("/projects/{project_id}/agent-settings")
async def list_agent_settings(
    project_id: str, session: AsyncSession = Depends(get_db)
):
    r = await session.execute(
        text(
            "SELECT pas.*, ac.agent_name, ac.agent_type, ac.description AS agent_description, "
            "ac.default_trust_level "
            "FROM project_agent_setting pas "
            "JOIN agent_catalog ac ON pas.agent_catalog_id = ac.id "
            "WHERE pas.project_id = :pid "
            "ORDER BY ac.agent_name"
        ),
        {"pid": project_id},
    )
    return [dict(row) for row in r.mappings().all()]


@router.put("/projects/{project_id}/agent-settings/{setting_id}")
async def update_agent_setting(
    project_id: str,
    setting_id: str,
    body: AgentSettingUpdate,
    session: AsyncSession = Depends(get_db),
):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["sid"] = setting_id
    updates["pid"] = project_id
    r = await session.execute(
        text(
            f"UPDATE project_agent_setting SET {set_clause} "
            "WHERE id = :sid AND project_id = :pid RETURNING *"
        ),
        updates,
    )
    await session.commit()
    row = r.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Setting not found")
    return dict(row)
