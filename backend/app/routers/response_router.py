from fastapi import APIRouter, HTTPException, Query, Depends, UploadFile, File, Form
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified
from db import AsyncSessionLocal
from models import Response
from schemas.interview_schema import (
    SubmitAnswerRequest,
    UpdateResponseStatusRequest
)
from services.llm_service import llm_service
from utils.interview_utils import (
    get_interview_or_404,
    get_response_or_404,
    get_questions_list,
    question_text,
    format_duration
)
from services.storage_service import storage_service

router = APIRouter(prefix="/api/interview", tags=["responses"])

# def _auto_assign_status(score: int) -> str:
#     if score >= 80:
#         return "selected"
#     elif score >= 60:
#         return "potential"
#     elif score < 40:
#         return "not_selected"
#     else:
#         return "potential"

# async def _assign_status_if_needed(db, response, overall_analysis: dict):
#     if not overall_analysis:
#         return
    
#     status = getattr(response, 'status', None) or "no_status"
#     if status == "no_status":
#         score = overall_analysis.get("overall_score", 0)
#         response.status = _auto_assign_status(score)
#         response.status_source = "auto"
#         await db.commit()

async def _ensure_analysis(db, response, interview_id: str) -> dict:
    overall_analysis = getattr(response, "overall_analysis", None)
    if not overall_analysis and response.qa_history:
        try:
            overall_analysis = await llm_service.generate_final_analysis(str(interview_id), response.qa_history)
            setattr(response, "overall_analysis", overall_analysis)
            await db.commit()
        except Exception:
            pass
    return overall_analysis or {}

def _get_candidate_summary(overall_analysis: dict) -> str:
    return (
        overall_analysis.get("soft_skill_summary", "") or 
        overall_analysis.get("overall_feedback", "")
    )

def _calculate_duration(response) -> tuple[int, str]:
    if response.start_time and response.end_time:
        duration_seconds = int((response.end_time - response.start_time).total_seconds())
    else:
        duration_seconds = response.duration if response.duration else 0
    return duration_seconds, format_duration(duration_seconds)

def _build_question_summaries(interview, qa_history: list, overall_analysis: dict) -> list:
    all_questions = get_questions_list(interview)
    
    if interview.question_mode == "dynamic" and interview.question_count:
        while len(all_questions) < interview.question_count:
            all_questions.append({
                "question": f"Question {len(all_questions) + 1} (not generated - interview ended early)",
                "id": None
            })
    
    llm_summaries = {}
    if overall_analysis and "question_summaries" in overall_analysis:
        for qs in overall_analysis["question_summaries"]:
            llm_summaries[qs.get("question", "")] = qs.get("summary", "")
    
    question_summary = []
    for idx, q in enumerate(all_questions):
        q_text = question_text(q) if isinstance(q, dict) else str(q)
        
        summary = llm_summaries.get(q_text, "")
        if not summary and idx < len(qa_history):
            analysis = qa_history[idx].get("analysis", {})
            if isinstance(analysis, dict):
                summary = analysis.get("feedback") or analysis.get("summary", "")
        
        if not summary or summary.lower() == "not asked":
            status = "not_asked"
        elif summary.lower() == "not answered":
            status = "not_answered"
        else:
            status = "asked"
        
        question_summary.append({
            "question_number": idx + 1,
            "question": q_text,
            "status": status,
            "summary": summary
        })
    
    return question_summary

def _build_transcript(qa_history: list, candidate_name: str) -> list:
    transcript = []
    for qa in qa_history:
        if qa.get("question"):
            transcript.append({"speaker": "AI interviewer", "text": qa.get("question")})
        if qa.get("answer"):
            transcript.append({"speaker": candidate_name or "Candidate", "text": qa.get("answer")})
    return transcript

@router.post("/submit-answer")
async def submit_answer(request: SubmitAnswerRequest):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, request.response_id)
        interview = await get_interview_or_404(db, str(response.interview_id))

        qa_pair = {
            "question": request.question,
            "answer": request.transcript,
            "analysis": {}
        }

        updated_qa_history = list(response.qa_history or [])
        updated_qa_history.append(qa_pair)
        response.qa_history = updated_qa_history
        flag_modified(response, 'qa_history')
        response.current_question_index += 1

        if interview.context:
            try:
                analysis = await llm_service.analyze_response(
                    str(interview.id),
                    request.transcript,
                    {"question": request.question}
                )
                updated_qa_history[-1]["analysis"] = analysis or {}
                response.qa_history = updated_qa_history
                flag_modified(response, 'qa_history')
            except Exception:
                pass

        total_questions = (
            interview.question_count 
            if interview.question_mode == "dynamic" and interview.question_count 
            else len(get_questions_list(interview))
        )
        
        is_complete = response.current_question_index >= total_questions and total_questions > 0

        if is_complete:
            response.is_completed = True
            if not response.end_time:
                response.end_time = datetime.now(timezone.utc)
            
            if response.start_time and response.end_time:
                response.duration = int((response.end_time - response.start_time).total_seconds())
            
            if interview.context:
                try:
                    final_analysis = await llm_service.generate_final_analysis(
                        str(interview.id), response.qa_history
                    )
                    setattr(response, "overall_analysis", final_analysis)
                    #await _assign_status_if_needed(db, response, final_analysis)
                except Exception:
                    pass
        
        try:
            await db.commit()
            await db.refresh(response)
        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save response: {str(e)}")

        return {
            "ok": True,
            "complete": is_complete,
            "question_number": response.current_question_index,
            "total_questions": total_questions,
            "questions_answered": len(response.qa_history) if response.qa_history else 0,
            "analysis": qa_pair.get("analysis", {}),
            "final_analysis": getattr(response, "overall_analysis", None) if is_complete else None
        }

@router.get("/get-overall-analysis")
async def get_overall_analysis(interview_id: str = Query(...)):
    async with AsyncSessionLocal() as db:
        interview = await get_interview_or_404(db, interview_id)
        
        result = await db.execute(
            select(Response)
            .where(Response.interview_id == interview_id)
            .where(Response.is_completed == True)
        )
        responses = [
            r for r in result.scalars().all()
            if (r.qa_history and len(r.qa_history) > 0) or getattr(r, 'overall_analysis', None) is not None
        ]
        
        candidates = []
        total_duration = 0
        sentiment_counts = {"positive": 0, "neutral": 0, "negative": 0}
        status_counts = {"selected": 0, "potential": 0, "not_selected": 0, "no_status": 0}
        
        for r in responses:
            overall_analysis = await _ensure_analysis(db, r, str(interview.id))
            
            overall_score = overall_analysis.get("overall_score", 0)
            communication_score = overall_analysis.get("communication_score", 0)
            
            status = getattr(r, 'status', None) or "no_status"

            # if overall_analysis and status == "no_status":
            #     await _assign_status_if_needed(db, r, overall_analysis)
            #     status = r.status
            
            candidates.append({
                "response_id": str(r.id),
                "name": r.name,
                "email": r.email,
                "overall_score": overall_score,
                "communication_score": communication_score,
                "summary": _get_candidate_summary(overall_analysis),
                "status": status,
                "status_source": r.status_source if hasattr(r, 'status_source') else "manual",
                "created_at": r.created_at.isoformat() if r.created_at else None
            })
            
            if r.duration:
                total_duration += r.duration
            
            sentiment = overall_analysis.get("sentiment", "neutral").lower()
            sentiment_counts[sentiment] = sentiment_counts.get(sentiment, 0) + 1
            status_counts[status] = status_counts.get(status, 0) + 1
        
        candidates.sort(key=lambda x: x["overall_score"], reverse=True)
        
        total_responses = len(responses)
        avg_duration = format_duration(int(total_duration / total_responses) if total_responses > 0 else 0)
        
        # result.overall_analysis = overall_analysis
        # await db.commit()
        # await db.refresh(result)
        return {
            "ok": True,
            "interview": {
                "id": str(interview.id),
                "name": interview.name,
                "objective": interview.objective or "",
                "description": getattr(interview, "description", None) or "",
                "time_duration": interview.time_duration  
            },
            "candidates": candidates,
            "metrics": {
                "average_duration": avg_duration,  
                "average_duration_seconds": int(total_duration / total_responses) if total_responses > 0 else 0,
                "completion_rate": "100%",
                "sentiment": sentiment_counts,
                "status": {
                    "total_responses": total_responses,
                    **status_counts
                }
            }
        }


@router.get("/get-response")
async def get_response_detail(response_id: str = Query(...)):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, response_id)
        interview = await get_interview_or_404(db, str(response.interview_id))
        
        qa_history = response.qa_history or []
        #overall_analysis = await _ensure_analysis(db, response, str(interview.id))
        overall_analysis = response.overall_analysis or {}
        print(f"[DEBUG] Overall Analysis: {overall_analysis}")
        
        duration_seconds, duration_formatted = _calculate_duration(response)
        question_summary = _build_question_summaries(interview, qa_history, overall_analysis)
        transcript = _build_transcript(qa_history, response.name)
        
        return {
            "ok": True,
            "interview": {
                "id": str(interview.id),
                "name": interview.name,
                "objective": interview.objective or "",
                "time_duration": interview.time_duration
            },
            "candidate": {
                "response_id": str(response.id),
                "name": response.name,
                "email": response.email,
                "created_at": response.created_at.isoformat() if response.created_at else None
            },
            "recording": {
                "duration": duration_formatted,
                "duration_seconds": duration_seconds,
                "available": duration_seconds > 0
            },
            "general_summary": {
                "overall_score": overall_analysis.get("overall_score", 0),
                "overall_feedback": overall_analysis.get("overall_feedback", "") or overall_analysis.get("overallFeedback", ""),
                "communication_score": overall_analysis.get("communication_score", 0),
                "communication_feedback": overall_analysis.get("communication_feedback", ""),
                "sentiment": overall_analysis.get("sentiment", "neutral").lower(),
                "call_summary": ""
            },
            "question_summary": question_summary,
            "transcript": transcript,
            "qa_history": qa_history,
            "status": getattr(response, 'status', 'no_status'),
            "status_source": getattr(response, 'status_source', 'manual')
        }

@router.post("/update-response-status")
async def update_response_status(request: UpdateResponseStatusRequest):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, request.response_id)
        valid_statuses = ["selected", "shortlisted", "rejected", "not_selected", "potential", "no_status"]
        if request.status not in valid_statuses:
            raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}")
        
        response.status = request.status
        response.status_source = "manual"
        await db.commit()
        await db.refresh(response)
        
        return {"ok": True, "status": response.status, "status_source": response.status_source}

@router.post("/upload-candidate-image")
async def upload_candidate_image(image:UploadFile = File(...), response_id:str = Form(...)):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, response_id)
        content = await image.read()
        file_extension = image.filename.split('.')[-1].lower()

        storage_url = await storage_service.save_candidate_image(content, response_id, file_extension)

        response.candidate_image_url = storage_url
        await db.commit()
        await db.refresh(response)
        return {"ok": True, "storage_path": storage_url}

@router.post("/upload-candidate-video")
async def upload_candidate_video(response_id:str = Form(...)):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, response_id)
        # Extension will be auto-detected from chunks
        storage_url = await storage_service.save_candidate_video(response_id)

        response.candidate_video_url = storage_url
        await db.commit()
        await db.refresh(response)
        return {"ok": True, "message":"Uploaded successfully", "storage_path": storage_url}
