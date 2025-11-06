# CRUD endpoints for feedbacks

from fastapi import APIRouter, HTTPException
from db import AsyncSessionLocal
from sqlalchemy import select
from models import Feedback, Interview
from schemas.feedback_schema import CreateFeedbackRequest
from utils.interview_utils import commit_and_refresh


router = APIRouter(prefix="/api/feedback", tags=["feedback"])


@router.post("/candidate-feedback")
async def create_feedback(payload: CreateFeedbackRequest):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Interview).where(Interview.id == payload.interview_id))
        interview = result.scalar_one_or_none()
        if not interview:
            raise HTTPException(status_code=404, detail="Interview not found")

        fb = Feedback(
            interview_id=payload.interview_id,
            email=payload.email,
            feedback=payload.feedback,
            satisfaction=payload.satisfaction,
        )
        db.add(fb)
        await commit_and_refresh(db, fb)
        return {"status": "ok", "feedback_id": str(fb.id), "message": "Feedback submitted successfully"}
