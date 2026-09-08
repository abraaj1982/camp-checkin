"""
التعامل مع Google Sheets: قراءة/كتابة حالة آخر عدد مرصود، وإضافة صفوف البنود.

المصادقة عبر حساب خدمة (Service Account) — أنشئه من Google Cloud Console،
شارك الشيت مع بريد الحساب الإلكتروني (client_email)، وضع محتوى ملف JSON
في متغيّر البيئة GOOGLE_SERVICE_ACCOUNT_JSON (كنص JSON كامل، مناسب لسر GitHub Actions).
"""

import json

import gspread
from google.oauth2.service_account import Credentials

import config

_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

_DATA_HEADERS = [
    "رقم العدد",
    "تاريخ العدد",
    "النوع",
    "العنوان",
    "الرابط",
    "التصنيف",
    "سبب التصنيف",
    "الملخص",
    "الأثر المحتمل",
]


def _client() -> gspread.Client:
    raw = config.GOOGLE_SERVICE_ACCOUNT_JSON
    info = json.loads(raw) if raw.strip().startswith("{") else json.loads(open(raw, encoding="utf-8").read())
    creds = Credentials.from_service_account_info(info, scopes=_SCOPES)
    return gspread.authorize(creds)


def _get_or_create_worksheet(sheet: gspread.Spreadsheet, name: str, headers: list[str]) -> gspread.Worksheet:
    try:
        ws = sheet.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = sheet.add_worksheet(title=name, rows=1000, cols=len(headers) + 2)
        ws.append_row(headers)
    return ws


def get_last_seen_issue() -> str | None:
    sheet = _client().open_by_key(config.GOOGLE_SHEET_ID)
    ws = _get_or_create_worksheet(sheet, config.STATE_WORKSHEET_NAME, ["رقم آخر عدد", "تاريخه", "آخر تحديث"])
    values = ws.get_all_values()
    if len(values) < 2:
        return None
    return values[1][0] or None


def set_last_seen_issue(issue_number: str, issue_date: str) -> None:
    import datetime

    sheet = _client().open_by_key(config.GOOGLE_SHEET_ID)
    ws = _get_or_create_worksheet(sheet, config.STATE_WORKSHEET_NAME, ["رقم آخر عدد", "تاريخه", "آخر تحديث"])
    now = datetime.datetime.utcnow().isoformat(timespec="seconds")
    if ws.row_count < 2 or not ws.get_all_values()[1:]:
        ws.append_row([issue_number, issue_date, now])
    else:
        ws.update("A2:C2", [[issue_number, issue_date, now]])


def append_items(rows: list[list[str]]) -> None:
    if not rows:
        return
    sheet = _client().open_by_key(config.GOOGLE_SHEET_ID)
    ws = _get_or_create_worksheet(sheet, config.DATA_WORKSHEET_NAME, _DATA_HEADERS)
    ws.append_rows(rows, value_input_option="USER_ENTERED")
