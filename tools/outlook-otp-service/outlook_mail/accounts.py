from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ACCOUNT_SEPARATOR = "----"


@dataclass(frozen=True)
class OutlookAccount:
    email: str
    password: str = ""
    client_id: str = ""
    refresh_token: str = ""
    tenant: str = "consumers"
    raw_index: int = 0

    @property
    def has_oauth(self) -> bool:
        return bool(self.client_id and self.refresh_token)

    @property
    def masked(self) -> dict[str, str | int | bool]:
        return {
            "email": self.email,
            "has_password": bool(self.password),
            "client_id": mask_secret(self.client_id),
            "has_refresh_token": bool(self.refresh_token),
            "tenant": self.tenant,
            "raw_index": self.raw_index,
        }


def mask_secret(value: str, *, keep: int = 4) -> str:
    value = str(value or "")
    if not value:
        return ""
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}...{value[-keep:]}"


def parse_account_line(line: str, *, raw_index: int = 0, tenant: str = "consumers") -> OutlookAccount:
    cleaned = str(line or "").strip()
    if not cleaned:
        raise ValueError("account line is empty")
    if cleaned.startswith("#"):
        raise ValueError("account line is a comment")

    parts = [part.strip() for part in cleaned.split(ACCOUNT_SEPARATOR)]
    if len(parts) < 1:
        raise ValueError("account email is required")
    if len(parts) > 4:
        parts = parts[:3] + [ACCOUNT_SEPARATOR.join(parts[3:]).strip()]

    email = parts[0].lower()
    if not email or "@" not in email:
        raise ValueError("account email is invalid")

    password = parts[1] if len(parts) > 1 else ""
    client_id = parts[2] if len(parts) > 2 else ""
    refresh_token = parts[3] if len(parts) > 3 else ""
    if not password and not (client_id and refresh_token):
        raise ValueError("account requires password or client_id+refresh_token")

    return OutlookAccount(
        email=email,
        password=password,
        client_id=client_id,
        refresh_token=refresh_token,
        tenant=str(tenant or "consumers").strip() or "consumers",
        raw_index=raw_index,
    )


def parse_account_lines(lines: Iterable[str], *, tenant: str = "consumers") -> list[OutlookAccount]:
    accounts: list[OutlookAccount] = []
    for idx, line in enumerate(lines, start=1):
        cleaned = str(line or "").strip()
        if not cleaned or cleaned.startswith("#"):
            continue
        accounts.append(parse_account_line(cleaned, raw_index=idx, tenant=tenant))
    return accounts


def load_accounts(path: str | Path, *, tenant: str = "consumers") -> list[OutlookAccount]:
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"accounts file not found: {file_path}")
    return parse_account_lines(file_path.read_text(encoding="utf-8").splitlines(), tenant=tenant)


def pick_account(accounts: list[OutlookAccount], selector: str = "") -> OutlookAccount:
    if not accounts:
        raise ValueError("no accounts loaded")
    selector = str(selector or "").strip().lower()
    if not selector:
        return accounts[0]
    if selector.isdigit():
        idx = int(selector)
        if idx < 1 or idx > len(accounts):
            raise ValueError(f"account index out of range: {idx}")
        return accounts[idx - 1]
    for account in accounts:
        if account.email.lower() == selector:
            return account
    raise ValueError(f"account not found: {selector}")
