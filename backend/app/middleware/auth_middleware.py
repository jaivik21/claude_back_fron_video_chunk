from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import JSONResponse
import os
from functools import wraps

API_KEY = os.getenv("API_KEY")

PUBLIC_PATHS = {
    "/", 
    "/docs", 
    "/redoc", 
    "/openapi.json", 
    "/api/health",
    "/api/auth/login",
    "/api/auth/signup",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/interview/start-interview",
    "/api/interview/get-current-question",
    "/api/interview/end-interview",
    "/api/interview/submit-answer",
    "/api/feedback/candidate-feedback",
    "/api/interview/get-response",
    "/api/media/upload-candidate-video",
}

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        if request.method == "OPTIONS":
            return await call_next(request)
        if path in PUBLIC_PATHS:
            return await call_next(request)

        client_key = (
            request.headers.get("API_KEY")
            or request.headers.get("x-api-key")
        )
        if not client_key:
            return JSONResponse(status_code=401, content={"detail": "API key required"})
        if client_key != API_KEY:
            return JSONResponse(status_code=403, content={"detail": "Invalid API key"})

        return await call_next(request)


def safe_route(func):
    @wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except HTTPException:
            raise  
        except Exception as e:
            print(f"[ERROR] {func.__name__} failed: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    return wrapper