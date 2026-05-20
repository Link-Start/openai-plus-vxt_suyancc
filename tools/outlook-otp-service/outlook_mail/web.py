from __future__ import annotations

from typing import Any

from .accounts import parse_account_line
from .client import SearchOptions, fetch_message as fetch_message_by_uid, fetch_recent_messages


LIST_PREVIEW_BYTES = 4096
DEFAULT_MAILBOXES = ("INBOX", "Junk")


def _mailbox_names(value: str) -> list[str]:
    raw = str(value or "").strip()
    if not raw or raw.lower() in {"default", "all", "inbox+junk", "inbox,junk"}:
        return list(DEFAULT_MAILBOXES)
    names = [item.strip() for item in raw.split(",") if item.strip()]
    return names or list(DEFAULT_MAILBOXES)


def fetch_messages(
    account_line: str,
    *,
    limit: int = 10,
    mailbox: str = "INBOX",
    query: str = "",
    unseen_only: bool = False,
    mark_seen: bool = False,
    tenant: str = "consumers",
    use_password: bool = False,
) -> dict[str, Any]:
    account = parse_account_line(account_line, tenant=tenant)
    mailbox_names = _mailbox_names(mailbox)
    base_limit = max(1, min(int(limit or 10), 50))
    messages = []
    folder_errors: dict[str, str] = {}
    for mailbox_name in mailbox_names:
        options = SearchOptions(
            mailbox=mailbox_name,
            limit=base_limit,
            unseen_only=bool(unseen_only),
            query=str(query or "").strip(),
            mark_seen=bool(mark_seen),
        )
        try:
            records = fetch_recent_messages(
                account,
                options=options,
                use_password=use_password,
                preview_bytes=LIST_PREVIEW_BYTES,
            )
        except Exception as exc:
            folder_errors[mailbox_name] = str(exc)
            continue
        for index, record in enumerate(records, start=1):
            uid = str(record.uid or index)
            item = record.to_dict()
            item["uid"] = uid
            item["mailbox"] = mailbox_name
            item["id"] = f"{mailbox_name}:{uid}"
            item["partial"] = True
            item["preview_text"] = (record.text_body or record.body_excerpt or "").strip()[:500]
            item["text_body"] = ""
            item["html_body"] = ""
            item["raw_headers"] = ""
            item["raw_excerpt"] = ""
            item["body_excerpt"] = ""
            messages.append(item)
    messages.sort(key=lambda item: float(item.get("received_at") or 0), reverse=True)
    _hydrate_missing_otps(
        account_line,
        messages,
        tenant=tenant,
        use_password=use_password,
        max_messages=min(base_limit, 5),
    )
    if not messages and folder_errors:
        details = "; ".join(f"{name}: {error}" for name, error in folder_errors.items())
        raise RuntimeError(f"mailbox fetch failed: {details}")
    return {
        "account": {
            "email": account.email,
            "has_oauth": account.has_oauth,
            "tenant": account.tenant,
            "auth_mode": "oauth" if account.has_oauth and not use_password else "password",
            "masked": account.masked,
        },
        "messages": messages,
        "count": len(messages),
        "mailbox": ",".join(mailbox_names),
        "mailboxes": mailbox_names,
        "folder_errors": folder_errors,
        "limit": base_limit,
    }


def fetch_message(
    account_line: str,
    *,
    uid: str,
    mailbox: str = "INBOX",
    tenant: str = "consumers",
    use_password: bool = False,
) -> dict[str, Any]:
    account = parse_account_line(account_line, tenant=tenant)
    record = fetch_message_by_uid(
        account,
        str(uid),
        mailbox=str(mailbox or "INBOX").strip() or "INBOX",
        use_password=use_password,
    )
    item = record.to_dict()
    item["uid"] = str(record.uid or uid)
    item["mailbox"] = str(mailbox or "INBOX").strip() or "INBOX"
    item["id"] = f"{item['mailbox']}:{item['uid']}"
    item["partial"] = False
    return {"message": item}


def _hydrate_missing_otps(
    account_line: str,
    messages: list[dict[str, Any]],
    *,
    tenant: str = "consumers",
    use_password: bool = False,
    max_messages: int = 5,
) -> None:
    if any(str(item.get("otp") or "").strip() for item in messages):
        return
    for item in messages[: max(1, int(max_messages or 1))]:
        uid = str(item.get("uid") or "").strip()
        mailbox = str(item.get("mailbox") or "INBOX").strip() or "INBOX"
        if not uid:
            continue
        try:
            detail = fetch_message(
                account_line,
                uid=uid,
                mailbox=mailbox,
                tenant=tenant,
                use_password=use_password,
            ).get("message") or {}
        except Exception:
            continue
        otp = str(detail.get("otp") or "").strip()
        if not otp:
            continue
        item["otp"] = otp
        item["subject"] = detail.get("subject") or item.get("subject") or ""
        item["from_addr"] = detail.get("from_addr") or item.get("from_addr") or ""
        item["received_at"] = detail.get("received_at") or item.get("received_at") or 0
        item["partial"] = False
        item["preview_text"] = (detail.get("text_body") or detail.get("body_excerpt") or item.get("preview_text") or "").strip()[:500]
        return
