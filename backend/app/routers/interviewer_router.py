from fastapi import APIRouter, HTTPException, Form, Query, Request, Depends
from typing import Optional
from sqlalchemy import select
from db import AsyncSessionLocal
from models import Interviewer
from schemas.interview_schema import (
    UpdateInterviewerRequest,
    DeleteInterviewerRequest
)
from middleware.auth_middleware import safe_route
import uuid

router = APIRouter(prefix="/api/interviewer", tags=["interviewer"])

async def get_interviewer_or_404(db, interviewer_id: str):
    result = await db.execute(
        select(Interviewer).where(Interviewer.id == uuid.UUID(interviewer_id))
    )
    interviewer = result.scalar_one_or_none()
    if not interviewer:
        raise HTTPException(status_code=404, detail="Interviewer not found")
    return interviewer

def serialize_interviewer(interviewer):
    return {
        "id": str(interviewer.id),
        "name": interviewer.name,
        "accent": interviewer.accent,
        "elevenlabs_voice_id": interviewer.elevenlabs_voice_id,
        "created_at": interviewer.created_at.isoformat() if interviewer.created_at else None,
        "is_active": interviewer.is_active
    }

@router.post("/create-interviewer")
@safe_route
async def create_interviewer(
    name: str = Form(...),
    accent: Optional[str] = Form(None),
    elevenlabs_voice_id: Optional[str] = Form(None),
    is_active: Optional[bool] = Form(True),
):
    async with AsyncSessionLocal() as db:
        try:
            interviewer = Interviewer(
                name=name,
                accent=accent,
                elevenlabs_voice_id=elevenlabs_voice_id,
                is_active=is_active
            )
            db.add(interviewer)
            await db.commit()
            await db.refresh(interviewer)
            return serialize_interviewer(interviewer)
        except Exception as e:
            await db.rollback()
            raise 

@router.get("/list-interviewers")
@safe_route
async def list_interviewers():
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Interviewer).where(Interviewer.is_active == True).order_by(Interviewer.created_at.desc())
        )
        interviewers = result.scalars().all()
        return {
            "ok": True,
            "interviewers": [serialize_interviewer(i) for i in interviewers]
        }

@router.get("/get-interviewer")
@safe_route
async def get_interviewer(
    interviewer_id: str = Query(...),
):
    async with AsyncSessionLocal() as db:
        interviewer = await get_interviewer_or_404(db, interviewer_id)
        return serialize_interviewer(interviewer)

@router.post("/update-interviewer")
@safe_route
async def update_interviewer(
    payload: UpdateInterviewerRequest,
):
    async with AsyncSessionLocal() as db:
        interviewer = await get_interviewer_or_404(db, payload.interviewer_id)
        
        if payload.name is not None:
            interviewer.name = payload.name
        if payload.accent is not None:
            interviewer.accent = payload.accent
        if payload.elevenlabs_voice_id is not None:
            interviewer.elevenlabs_voice_id = payload.elevenlabs_voice_id
        if payload.is_active is not None:
            interviewer.is_active = payload.is_active

        try:
            await db.commit()
            await db.refresh(interviewer)
            return serialize_interviewer(interviewer)
        except Exception as e:
            await db.rollback()
            raise  

@router.post("/delete-interviewer")
@safe_route
async def delete_interviewer(
    payload: DeleteInterviewerRequest,
):
    async with AsyncSessionLocal() as db:
        interviewer = await get_interviewer_or_404(db, payload.interviewer_id)
        try:
            await db.delete(interviewer)
            await db.commit()
            return {"ok": True, "message": "Interviewer deleted successfully"}
        except Exception as e:
            await db.rollback()
            raise  

