"""piWebUI 身份鉴权与密码安全层 (PBKDF2-HMAC + JWT)"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Optional

import jwt

from db import User

log = logging.getLogger("piweb.auth")

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
SECRET_FILE = PROJECT_DIR / ".pi" / "jwt.secret"


def get_jwt_secret() -> str:
    """获取或自动生成持久化的 JWT 密钥（保证服务重启时已登录会话不掉线）。"""
    env_secret = os.environ.get("PI_JWT_SECRET", "").strip()
    if env_secret:
        return env_secret

    if SECRET_FILE.is_file():
        try:
            val = SECRET_FILE.read_text(encoding="utf-8").strip()
            if val:
                return val
        except Exception as e:
            log.warning("读取 jwt.secret 失败: %s", e)

    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    generated = secrets.token_urlsafe(48)
    try:
        SECRET_FILE.write_text(generated, encoding="utf-8")
        log.info("已生成并持久化全新的 JWT 签名密钥")
    except Exception as e:
        log.warning("保存 jwt.secret 失败: %s", e)

    return generated


JWT_SECRET = get_jwt_secret()
JWT_ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    """使用 PBKDF2-HMAC-SHA256 安全加盐哈希密码（100,000 次迭代，防御彩虹表）。"""
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        100_000,
    )
    return f"{salt}:{key.hex()}"


def verify_password(password: str, hashed: str) -> bool:
    """验证密码是否与加盐哈希匹配，采用常量时间比较防时序攻击。"""
    try:
        salt, key_hex = hashed.split(":", 1)
        key = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            100_000,
        )
        return hmac.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


def create_access_token(user: User, expires_days: int = 7) -> str:
    """为用户签发 JWT 访问令牌。"""
    now = int(time.time())
    exp = now + (expires_days * 86400)
    payload = {
        "sub": user.id,
        "username": user.username,
        "role": user.role,
        "iat": now,
        "exp": exp,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    """解析并校验 JWT 令牌有效性。"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except (jwt.PyJWTError, Exception):
        return None

