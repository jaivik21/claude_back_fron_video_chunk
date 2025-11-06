import socketio
from utils.redis_utils import create_session, add_audio_chunk, get_audio_chunks, remove_session
from services.stt_service import stt_service 
from sqlalchemy import select
from db import AsyncSessionLocal
from models import Response
from services.storage_service import storage_service
import asyncio
import base64

sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
_sessions = {}

async def _cleanup_session(sid):
    sess = _sessions.pop(sid, None)
    if not sess:
        return

    if "audio_queue" in sess and sess["audio_queue"]:
        await sess["audio_queue"].put(None)

    for task_name in ["stt_task", "emitter_task"]:
        if task_name in sess and sess[task_name]:
            try:
                sess[task_name].cancel()
                await sess[task_name]
            except asyncio.CancelledError:
                pass  

    if "session_id" in sess:
        await remove_session(sess["session_id"])
        await sio.leave_room(sid, sess["session_id"])


@sio.event
async def connect(sid, environ):
    await sio.emit("connected", {"sid": sid}, to=sid)


@sio.event
async def disconnect(sid):
    await _cleanup_session(sid)


@sio.event
async def start_interview(sid, data):
    interview_id = data.get("interview_id")
    response_id = data.get("response_id")
    
    if not interview_id:
        return {"ok": False, "error": "interview_id is required"}
    

    async with AsyncSessionLocal() as session:
        from models import Interview
        result = await session.execute(select(Interview).where(Interview.id == interview_id))
        interview = result.scalar_one_or_none()
        
        if not interview:
            return {"ok": False, "error": f"Interview with id {interview_id} not found"}
        
        if not interview.is_active:
            return {"ok": False, "error": "Interview is not active"}
    

    session_id = f"{interview_id}_{response_id}"
    await create_session(session_id)
    

    audio_queue = asyncio.Queue()
    transcript_queue = asyncio.Queue()

    async def transcript_emitter(sid, t_queue):
        last_partial = ""
        while True:
            try:
                update = await t_queue.get()
                if update is None: break
                text = update["text"] if isinstance(update, dict) else str(update)
                is_final = update.get("is_final") if isinstance(update, dict) else True
                await sio.emit("partial_transcript", {"text": text, "is_final": is_final}, to=sid)
                if is_final:  
                    last_partial = ""
            except asyncio.CancelledError:
                break
        
    emitter_task = asyncio.create_task(transcript_emitter(sid, transcript_queue))
    stt_task = asyncio.create_task(stt_service.stream_transcribe_session(audio_queue, transcript_queue))
    
    _sessions[sid] = {
        "session_id": session_id, 
        "response_id": response_id,
        "audio_queue": audio_queue,
        "stt_task": stt_task,
        "emitter_task": emitter_task,
    }
    await sio.enter_room(sid, session_id)

    
    return {"ok": True, "session_id": session_id, "response_id":response_id}


@sio.event
async def send_audio_chunk(sid, data):
    sess = _sessions.get(sid)
    if not sess:
        return {"ok": False, "error": "No active session"}

    chunk_bytes = data if isinstance(data, (bytes, bytearray)) else data.get("chunk_data", data)
    
    if chunk_bytes:
        await sess["audio_queue"].put(chunk_bytes)
        await add_audio_chunk(sess["session_id"], chunk_bytes)
        return {"ok": True}
    
    return {"ok": False, "error": "Empty audio chunk"}


@sio.event
async def save_video_chunk(sid, data):
    response_id = data.get("response_id")
    chunk = data.get("chunk")
    # Force MP4-only pipeline regardless of what client sends
    file_extension = "mp4"

    if not chunk or not response_id:
        await sio.emit("error", {"error": "Invalid data received"}, to=sid)
        return
    
    try:
        if chunk.startswith("data:"):
            chunk = chunk.split(",")[1]
        chunk_bytes = base64.b64decode(chunk)
    except Exception as e:
        await sio.emit("error", {"error": f"Base64 decode failed: {str(e)}"}, to=sid)
        return
    await storage_service.save_chunk(chunk_bytes, response_id, file_extension)
    await sio.emit("video_chunk_saved", {"ok": True}, to=sid)


@sio.event
async def end_interview(sid, data=None):
    sess = _sessions.get(sid)
    if not sess:
        return {"ok": False, "error": "No active session"}
    session_id = sess["session_id"]
    response_id = sess["response_id"]

    if "audio_queue" in sess:
        try:
            await sess["audio_queue"].put(None)
        except Exception:
            pass

    for task_name in ["stt_task", "emitter_task"]:
        task = sess.get(task_name)
        if task:
            try:
                task.cancel()
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

    try:
        final_text = await stt_service.transcribe_session(session_id)
        await sio.emit("transcript_result", {"text": final_text}, to=sid)

        async with AsyncSessionLocal() as session:
            result = await session.execute(select(Response).where(Response.id == response_id))
            resp = result.scalar_one_or_none()
            if resp:
                if hasattr(resp, 'transcripts') and isinstance(resp.transcripts, list):
                    resp.transcripts.append(final_text)
                else:
                    pass
                resp.is_ended = True
                await session.commit()

        return {"ok": True, "final": True, "transcript": final_text}
    finally:
        try:
            await remove_session(session_id)
        except Exception:
            pass
        try:
            await sio.leave_room(sid, session_id)
        except Exception:
            pass
        _sessions.pop(sid, None)