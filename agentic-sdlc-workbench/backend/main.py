"""FastAPI app entry point. Startup runs migrations. Mounts static frontend."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from database import run_sql_files, AsyncSessionLocal, current_user_id_var
from sqlalchemy import text

# Routers
from routers import (
    auth,
    dashboard,
    projects,
    agent_settings,
    change_packets,
    evidence,
    audit,
    baselines,
    exceptions_q,
    reports,
    design,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run SQL migrations on startup."""
    await run_sql_files()
    yield


app = FastAPI(
    title="Agentic SDLC Workbench API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow all origins for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def inject_user_id_middleware(request: Request, call_next):
    """For every request: set ContextVar and open a transaction with SET LOCAL."""
    user_id = request.headers.get("X-User-ID", "")
    token = current_user_id_var.set(user_id)
    try:
        response = await call_next(request)
        return response
    finally:
        current_user_id_var.reset(token)


# Include all routers
PREFIX = "/api/v1"
app.include_router(auth.router, prefix=PREFIX, tags=["auth"])
app.include_router(dashboard.router, prefix=PREFIX, tags=["dashboard"])
app.include_router(projects.router, prefix=PREFIX, tags=["projects"])
app.include_router(agent_settings.router, prefix=PREFIX, tags=["agent-settings"])
app.include_router(change_packets.router, prefix=PREFIX, tags=["change-packets"])
app.include_router(evidence.router, prefix=PREFIX, tags=["evidence"])
app.include_router(audit.router, prefix=PREFIX, tags=["audit"])
app.include_router(baselines.router, prefix=PREFIX, tags=["baselines"])
app.include_router(exceptions_q.router, prefix=PREFIX, tags=["exceptions"])
app.include_router(reports.router, prefix=PREFIX, tags=["reports"])
app.include_router(design.router, prefix=PREFIX, tags=["design"])


@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}


# Mount frontend static files — must come last
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
