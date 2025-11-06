from fastapi import APIRouter, Query, HTTPException, Request, Depends
from typing import Optional
from sqlalchemy import select
from db import AsyncSessionLocal
from models import Interviewer
from schemas.interview_schema import GenerateQuestionsRequest
from services.question_service import QuestionService
from utils.interview_utils import get_interview_or_404, get_response_or_404, get_questions_list, question_text, synthesize_tts
from middleware.auth_middleware import safe_route

router = APIRouter(prefix="/api/interview", tags=["questions"])


async def _get_voice_id(db, interview) -> Optional[str]:
    if interview.interviewer_id:
        try:
            interviewer_result = await db.execute(
                select(Interviewer).where(Interviewer.id == interview.interviewer_id)
            )
            interviewer = interviewer_result.scalar_one_or_none()
            if interviewer and interviewer.elevenlabs_voice_id:
                return interviewer.elevenlabs_voice_id
        except Exception:
            pass
    
    try:
        from services.tts_service import tts_service
        if hasattr(tts_service.provider, 'default_voice_id'):
            return tts_service.provider.default_voice_id
    except Exception:
        pass
    
    return None


async def _add_tts_to_result(result: dict, q_text: str, voice_id: Optional[str]) -> None:
    if voice_id and q_text:
        try:
            tts_data = await synthesize_tts(q_text, voice_id)
            if tts_data:
                result.update(tts_data)
        except Exception as e:
            print(f"[ERROR] TTS synthesis failed: {e}")


@router.post("/generate-questions")
@safe_route
async def generate_questions(request: GenerateQuestionsRequest):
    async with AsyncSessionLocal() as db:
        interview = await get_interview_or_404(db, request.interview_id)
        context_for_llm = QuestionService.safe_get_context(interview)
        target_count = request.question_count if request.question_count and request.question_count > 0 else interview.question_count
        
        if interview.question_mode == "dynamic" and interview.auto_question_generate:
            generated_description = await QuestionService.handle_dynamic_mode_description(
                interview, db, context_for_llm
            )
            return {
                "ok": True,
                "questions": [],
                "mode": interview.question_mode,
                "description": generated_description or interview.description or ""
            }
        
        generated_description = None
        if interview.question_mode == "predefined" and not interview.auto_question_generate and interview.manual_questions:
            questions = await QuestionService.handle_manual_questions(interview, db, target_count)
        elif interview.question_mode == "predefined":
            questions, generated_description = await QuestionService.handle_predefined_questions(
                interview, db, target_count, context_for_llm
            )
        else:
            questions = []
        
        return {
            "ok": True,
            "questions": questions,
            "mode": interview.question_mode,
            "description": generated_description or interview.description or ""
        }


@router.get("/get-current-question")
@safe_route
async def get_current_question(response_id: str = Query(...)):
    async with AsyncSessionLocal() as db:
        response = await get_response_or_404(db, response_id)
        interview = await get_interview_or_404(db, str(response.interview_id))
        questions = get_questions_list(interview)
        
        if interview.question_mode == "dynamic":
            max_questions = interview.question_count
            
            if response.current_question_index >= max_questions:
                return {
                    "ok": True,
                    "complete": True,
                    "mode": interview.question_mode,
                    "message": f"Interview complete. You have answered all {max_questions} questions."
                }
            
            if response.current_question_index >= len(questions):
                previous_answers = response.qa_history or []
                
                if len(previous_answers) == 0:
                    context_for_llm = QuestionService.safe_get_context(interview)
                    first_q = await QuestionService.generate_first_dynamic_question(interview, db, context_for_llm)
                    if not first_q:
                        return {
                            "ok": False,
                            "error": "Failed to generate first question",
                            "mode": interview.question_mode
                        }
                    questions = get_questions_list(interview)
                elif len(previous_answers) < max_questions:
                    next_question = await QuestionService.generate_next_dynamic_question(
                        interview, db, previous_answers
                    )
                    if not next_question or next_question.get("error"):
                        return {
                            "ok": False,
                            "error": next_question.get("error", "Failed to generate next question") if next_question else "Failed to generate question",
                            "mode": interview.question_mode
                        }
                    questions = get_questions_list(interview)
                else:
                    return {"ok": True, "complete": True, "mode": interview.question_mode}
        
        if interview.question_mode == "predefined":
            if len(questions) > 0 and response.current_question_index >= len(questions):
                return {"ok": True, "complete": True, "mode": interview.question_mode}
            if len(questions) == 0:
                return {
                    "ok": False,
                    "error": "No questions available for this interview",
                    "mode": interview.question_mode
                }
        
        if response.current_question_index >= len(questions):
            return {
                "ok": False,
                "error": f"Question index {response.current_question_index} out of range. Expected < {len(questions)}",
                "mode": interview.question_mode
            }
        
        current_question = questions[response.current_question_index]
        if not current_question:
            return {
                "ok": False,
                "error": "Question not found at current index",
                "mode": interview.question_mode
            }
        
        q_text = question_text(current_question)
        total_questions_display = interview.question_count if interview.question_mode == "dynamic" else len(questions)
        
        result = {
            "ok": True,
            "current_question": current_question,
            "question_number": response.current_question_index + 1,
            "total_questions": total_questions_display,
            "mode": interview.question_mode
        }
        
        voice_id = await _get_voice_id(db, interview)
        await _add_tts_to_result(result, q_text, voice_id)
        
        return result
