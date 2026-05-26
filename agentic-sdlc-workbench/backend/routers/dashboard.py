"""Dashboard summary endpoint."""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from deps import get_db

router = APIRouter()


@router.get("/dashboard")
async def get_dashboard(session: AsyncSession = Depends(get_db)):
    # Active projects
    r = await session.execute(
        text("SELECT COUNT(*) FROM project WHERE status = 'active'")
    )
    active_projects = r.scalar()

    # Open change packets
    r = await session.execute(
        text("SELECT COUNT(*) FROM change_packet WHERE status NOT IN ('approved','rejected','archived')")
    )
    open_change_packets = r.scalar()

    # Failed validations
    r = await session.execute(
        text(
            "SELECT COUNT(*) FROM exception_queue "
            "WHERE exception_type = 'failed_validation' AND status = 'open'"
        )
    )
    failed_validations = r.scalar()

    # Pending approvals
    r = await session.execute(
        text("SELECT COUNT(*) FROM change_packet WHERE status = 'pending'")
    )
    pending_approvals = r.scalar()

    # Recent audit log — last 10 rows
    r = await session.execute(
        text(
            "SELECT table_name, record_id, operation, changed_at, changed_by "
            "FROM asdlc_audit_log ORDER BY changed_at DESC LIMIT 10"
        )
    )
    recent_changes = [dict(row) for row in r.mappings().all()]

    # Missing owner exceptions (open, up to 6)
    r = await session.execute(
        text(
            "SELECT * FROM exception_queue "
            "WHERE exception_type = 'missing_owner' AND status = 'open' "
            "ORDER BY created_at DESC LIMIT 6"
        )
    )
    missing_owners = [dict(row) for row in r.mappings().all()]

    # Reusable records: knowledge_articles + hitl_gates visible to ALL_CLIENTS (up to 9)
    r = await session.execute(
        text(
            "SELECT id, 'knowledge_article' AS record_type, title, visibility_scope "
            "FROM knowledge_article WHERE visibility_scope = 'ALL_CLIENTS' "
            "UNION ALL "
            "SELECT id, 'hitl_gate' AS record_type, gate_name AS title, visibility_scope "
            "FROM hitl_gate WHERE visibility_scope = 'ALL_CLIENTS' "
            "LIMIT 9"
        )
    )
    reusable_records = [dict(row) for row in r.mappings().all()]

    return {
        "active_projects": active_projects,
        "open_change_packets": open_change_packets,
        "failed_validations": failed_validations,
        "pending_approvals": pending_approvals,
        "recent_changes": recent_changes,
        "missing_owners": missing_owners,
        "reusable_records": reusable_records,
    }
