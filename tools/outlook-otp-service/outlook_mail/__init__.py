from __future__ import annotations

from .accounts import OutlookAccount, load_accounts, parse_account_line
from .client import OutlookIMAPClient, SearchOptions, fetch_recent_messages, wait_for_otp
from .parser import MessageRecord, extract_otp, parse_message

__all__ = [
    "MessageRecord",
    "OutlookAccount",
    "OutlookIMAPClient",
    "SearchOptions",
    "extract_otp",
    "fetch_recent_messages",
    "load_accounts",
    "parse_account_line",
    "parse_message",
    "wait_for_otp",
]
