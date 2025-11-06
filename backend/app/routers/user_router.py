# CRUD endpoints for users

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from db import AsyncSessionLocal
from models import User
from schemas.user_schema import SignupRequest, LoginRequest, UserResponse, AuthResponse, ForgotPasswordRequest, ResetPasswordRequest
from utils.user_auth import hash_password, verify_password, create_access_token, send_email
import os
import secrets
from datetime import datetime, timedelta, timezone


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=AuthResponse)
async def signup(payload: SignupRequest):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == payload.email))
        existing = result.scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="Email already in use")

        user = User(
            first_name=payload.first_name,
            last_name=payload.last_name,
            email=payload.email,
            password_hash=hash_password(payload.password),
        )
        db.add(user)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Email already in use")
        await db.refresh(user)

        token = create_access_token({"sub": str(user.id), "email": user.email})
        return AuthResponse(
            access_token=token,
            user=UserResponse(id=user.id, first_name=user.first_name, last_name=user.last_name, email=user.email, created_at=user.created_at),
        )


@router.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == payload.email))
        user = result.scalar_one_or_none()
        if not user or not verify_password(payload.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        token = create_access_token({"sub": str(user.id), "email": user.email})
        return AuthResponse(
            access_token=token,
            user=UserResponse(id=user.id, first_name=user.first_name, last_name=user.last_name, email=user.email, created_at=user.created_at),
        )


@router.post("/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == payload.email))
        user = result.scalar_one_or_none()
        if not user:
            return {"ok": True}

        user.reset_token = secrets.token_urlsafe(32)
        user.reset_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await db.commit()

        reset_link = f"{os.getenv('FRONTEND_BASE_URL', 'http://localhost:5173')}/reset-password?token={user.reset_token}"
        try:
            send_email(
                user.email,
                "Reset your password",
                f"Hello {user.first_name},\n\nClick the link below to reset your password.\n\n{reset_link}\n\nThis link expires in 1 hour.\n"
            )
        except Exception:
            pass
        return {"ok": True}


@router.post("/reset-password")
async def reset_password(payload: ResetPasswordRequest):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.reset_token == payload.token))
        user = result.scalar_one_or_none()
        
        if not user or not user.reset_token_expires_at or user.reset_token_expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Invalid or expired token")

        user.password_hash = hash_password(payload.new_password)
        user.reset_token = None
        user.reset_token_expires_at = None
        await db.commit()
        return {"ok": True}

