# Entry point (Socket.IO + FastAPI app)

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.cors import CORSMiddleware
import socketio
from sockets.interview_socket import sio
from utils.redis_utils import close_redis
from socketio import ASGIApp 
import sockets.interview_socket
from routers.interview_router import router as interview_router
from routers.question_router import router as question_router
from routers.response_router import router as response_router
from routers.session_router import router as session_router
from routers.interviewer_router import router as interviewer_router
from routers.user_router import router as user_router
from routers.feedback_router import router as feedback_router
from routers.media_router import router as media_router
from middleware.auth_middleware import AuthMiddleware
from dotenv import load_dotenv
from contextlib import asynccontextmanager
import uvicorn

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await close_redis()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(AuthMiddleware)

sio_app = socketio.ASGIApp(sio)
app.mount("/socket.io", sio_app)

app.include_router(interview_router)
app.include_router(question_router)
app.include_router(response_router)
app.include_router(session_router)
app.include_router(interviewer_router)
app.include_router(user_router)
app.include_router(feedback_router)
app.include_router(media_router)


@app.get("/")
async def root():
    return {"message": "AI Interview Tool API", "websocket": "/socket.io"}

@app.get("/api/interview/health")
async def health_check():
    """Health check endpoint"""
    return {"ok": True, "message": "Interview API is healthy"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)