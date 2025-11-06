from fastapi import APIRouter, UploadFile, File, HTTPException, Form
from typing import Dict
from services.storage_service import storage_service
from db import AsyncSessionLocal
from utils.interview_utils import get_response_or_404


router = APIRouter(prefix="/api/media", tags=["media"])


# Note: These endpoints may not be actively used. 
# Image upload should use /api/interview/upload-candidate-image with response_id
# Video uploads are handled via chunks through Socket.IO
# Keeping these for backward compatibility but they may need response_id

@router.post("/upload-candidate-image")
async def upload_candidate_image(file: UploadFile = File(...)) -> Dict[str, str]:
    """Legacy endpoint - consider using /api/interview/upload-candidate-image instead"""
    try:
        data = await file.read()
        # This endpoint needs response_id to work properly
        # For now, return error suggesting the correct endpoint
        raise HTTPException(
            status_code=400, 
            detail="This endpoint requires response_id. Please use /api/interview/upload-candidate-image instead"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to save image") from e


@router.post("/upload-screen-recording")
async def upload_screen_recording(file: UploadFile = File(...)) -> Dict[str, str]:
    """Legacy endpoint - screen recordings are handled via chunks through Socket.IO"""
    try:
        # Screen recordings are sent as chunks via Socket.IO, not as single file uploads
        raise HTTPException(
            status_code=400,
            detail="Screen recordings are handled via chunks through Socket.IO. This endpoint is not used."
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to save video") from e


@router.post("/upload-candidate-video")
async def upload_candidate_video(response_id: str = Form(...)):
    """Merge video chunks and save the final video"""
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, response_id)
        # Extension will be auto-detected from chunks
        storage_url = await storage_service.save_candidate_video(response_id)

        response.candidate_video_url = storage_url
        await db.commit()
        await db.refresh(response)
        return {"ok": True, "message": "Uploaded successfully", "storage_path": storage_url}

