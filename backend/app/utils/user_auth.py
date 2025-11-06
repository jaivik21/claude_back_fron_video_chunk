import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from passlib.context import CryptContext
import jwt
import os
import smtplib
from email.message import EmailMessage


_pwd_context = CryptContext(schemes=["bcrypt_sha256", "bcrypt"], deprecated="auto")
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-prod")
JWT_ALG = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))


def hash_password(plain_password: str) -> str:
    if not plain_password:
        raise ValueError("Password cannot be empty")
    return _pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    if not plain_password:
        return False
    return _pwd_context.verify(plain_password, password_hash)


def create_access_token(subject: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    to_encode = subject.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=JWT_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALG)


def decode_access_token(token: str) -> Dict[str, Any]:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])


def send_email(to_email: str, subject: str, body_text: str) -> None:
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    from_email = os.getenv("SMTP_FROM", user or "no-reply@example.com")

    if not host or not user or not password:
        print(f"[EMAIL_FALLBACK] To: {to_email}\nSubject: {subject}\n\n{body_text}")
        return

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body_text)

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        server.send_message(msg)



