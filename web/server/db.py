"""piWebUI 数据库持久化层 (基于 Python 原生 sqlite3)
管理用户表、基础配置与审计记录，单文件免运维。
"""

from __future__ import annotations

import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("piweb.db")

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DB_DIR = PROJECT_DIR / ".pi"
DB_PATH = DB_DIR / "piweb.db"


@dataclass
class User:
    id: str
    username: str
    password_hash: str
    role: str  # 'admin' | 'user'
    status: str  # 'active' | 'disabled'
    created_at: int

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "status": self.status,
            "created_at": self.created_at,
        }


def get_connection() -> sqlite3.Connection:
    """获取 SQLite 数据库连接并开启 WAL 模式以提升并发性能。"""
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    """初始化数据库表结构。"""
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                detail TEXT,
                created_at INTEGER NOT NULL
            );
            """
        )
    log.info("SQLite 数据库初始化完成: %s", DB_PATH)


def count_users() -> int:
    """获取当前注册用户总数。"""
    with get_connection() as conn:
        cur = conn.execute("SELECT COUNT(*) AS c FROM users;")
        row = cur.fetchone()
        return int(row["c"]) if row else 0


def create_user(
    username: str,
    password_hash: str,
    role: Optional[str] = None,
) -> User:
    """创建新用户。如果系统中尚无任何用户，首个用户自动设定为 admin。"""
    username = username.strip().lower()
    now = int(time.time())

    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) AS c FROM users;").fetchone()["c"]
        assigned_role = role or ("admin" if total == 0 else "user")
        user_id = uuid.uuid4().hex

        conn.execute(
            """
            INSERT INTO users (id, username, password_hash, role, status, created_at)
            VALUES (?, ?, ?, ?, 'active', ?);
            """,
            (user_id, username, password_hash, assigned_role, now),
        )

    log.info("已创建新用户: %s (角色: %s, ID: %s)", username, assigned_role, user_id)
    return User(
        id=user_id,
        username=username,
        password_hash=password_hash,
        role=assigned_role,
        status="active",
        created_at=now,
    )


def get_user_by_id(user_id: str) -> Optional[User]:
    """通过 ID 查询用户。"""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?;", (user_id,)).fetchone()
        if not row:
            return None
        return User(
            id=row["id"],
            username=row["username"],
            password_hash=row["password_hash"],
            role=row["role"],
            status=row["status"],
            created_at=row["created_at"],
        )


def get_user_by_username(username: str) -> Optional[User]:
    """通过用户名查询用户。"""
    username = username.strip().lower()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?;", (username,)
        ).fetchone()
        if not row:
            return None
        return User(
            id=row["id"],
            username=row["username"],
            password_hash=row["password_hash"],
            role=row["role"],
            status=row["status"],
            created_at=row["created_at"],
        )


def list_users() -> list[User]:
    """获取所有用户列表（不包含密码哈希）。"""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, username, role, status, created_at, password_hash FROM users ORDER BY created_at ASC;"
        ).fetchall()
        return [
            User(
                id=r["id"],
                username=r["username"],
                password_hash=r["password_hash"],
                role=r["role"],
                status=r["status"],
                created_at=r["created_at"],
            )
            for r in rows
        ]


def record_audit(user_id: str, action: str, detail: str = "") -> None:
    """记录用户操作审计日志。"""
    try:
        with get_connection() as conn:
            conn.execute(
                """
                INSERT INTO audit_logs (user_id, action, detail, created_at)
                VALUES (?, ?, ?, ?);
                """,
                (user_id, action, detail[:500], int(time.time())),
            )
    except Exception as e:
        log.warning("记录审计日志失败: %s", e)

