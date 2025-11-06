# Feedback validation schemas

from pydantic import BaseModel, EmailStr, Field
from uuid import UUID
from typing import Optional


class CreateFeedbackRequest(BaseModel):
    interview_id: UUID
    email: Optional[EmailStr] = None
    feedback: str 
    satisfaction: int 

