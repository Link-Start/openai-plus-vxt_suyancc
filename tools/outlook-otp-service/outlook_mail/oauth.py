from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests

from .accounts import OutlookAccount


DEFAULT_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
TOKEN_URL_TEMPLATE = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"


@dataclass(frozen=True)
class OAuthToken:
    access_token: str
    expires_in: int = 0
    scope: str = ""
    token_type: str = "Bearer"


class OAuthError(RuntimeError):
    pass


def refresh_access_token(
    account: OutlookAccount,
    *,
    scope: str = DEFAULT_SCOPE,
    timeout_s: float = 30.0,
) -> OAuthToken:
    if not account.client_id or not account.refresh_token:
        raise OAuthError("client_id and refresh_token are required")

    url = TOKEN_URL_TEMPLATE.format(tenant=account.tenant or "consumers")
    data = {
        "client_id": account.client_id,
        "grant_type": "refresh_token",
        "refresh_token": account.refresh_token,
        "scope": scope,
    }
    try:
        resp = requests.post(url, data=data, timeout=timeout_s)
    except requests.RequestException as exc:
        raise OAuthError(f"token refresh request failed: {exc}") from exc

    payload: dict[str, Any]
    try:
        payload = resp.json()
    except ValueError:
        payload = {"error": "non_json_response", "error_description": resp.text[:500]}

    if resp.status_code >= 400 or not payload.get("access_token"):
        code = payload.get("error") or resp.status_code
        description = payload.get("error_description") or payload.get("error_uri") or "token refresh failed"
        raise OAuthError(f"{code}: {description}")

    return OAuthToken(
        access_token=str(payload.get("access_token") or ""),
        expires_in=int(payload.get("expires_in") or 0),
        scope=str(payload.get("scope") or ""),
        token_type=str(payload.get("token_type") or "Bearer"),
    )
