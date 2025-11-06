# Common decorators for route handlers

from functools import wraps
from fastapi import HTTPException


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

