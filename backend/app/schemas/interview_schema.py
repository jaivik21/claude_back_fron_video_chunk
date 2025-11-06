from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import uuid


class StartInterviewRequest(BaseModel):
    interview_id: str
    candidate_name: str
    candidate_email: str

class EndInterviewRequest(BaseModel):
    response_id: str
    reason: Optional[str] = "Candidate requested to end interview"

class SubmitAnswerRequest(BaseModel):
    response_id: str
    question: str
    transcript: str

class InterviewResponse(BaseModel):
    id: str
    name: str
    objective: str
    mode: str
    question_count: int
    context: Optional[Dict[str, Any]] = None
    questions: Optional[List[Dict[str, Any]]] = None
    candidate_link: Optional[str] = None
    description: Optional[str] = None
    is_open: Optional[bool] = True
    interviewer_id: Optional[str] = None

class UpdateInterviewRequest(BaseModel):
    name: Optional[str] = None
    objective: Optional[str] = None
    mode: Optional[str] = None  # 'predefined' | 'dynamic'
    question_count: Optional[int] = None
    auto_question_generate: Optional[bool] = None
    manual_questions: Optional[List[Dict[str, Any]]] = None

class DeleteInterviewRequest(BaseModel):
    interview_id: str

class ToggleInterviewStatusRequest(BaseModel):
    interview_id: str

class GenerateQuestionsRequest(BaseModel):
    interview_id: str
    question_count: Optional[int] = 5

class UpdateResponseStatusRequest(BaseModel):
    response_id: str
    status: str

class UpdateInterviewerRequest(BaseModel):
    interviewer_id: str
    name: Optional[str] = None
    accent: Optional[str] = None
    elevenlabs_voice_id: Optional[str] = None
    is_active: Optional[bool] = None

class DeleteInterviewerRequest(BaseModel):
    interviewer_id: str