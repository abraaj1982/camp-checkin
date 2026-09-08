"""
إعدادات أداة رصد التشريعات العُمانية (qanoon.om).

القيم الحساسة (مفاتيح API، معرّف الشيت) تُقرأ من متغيرات البيئة —
لا تضع أي مفتاح هنا مباشرة.
"""

import os

# --- مصدر البيانات ---
ARCHIVE_URL = os.environ.get("QANOON_ARCHIVE_URL", "https://qanoon.om")

# محددات CSS لاستخراج قائمة الأعداد من صفحة الأرشيف.
# هذه قيم افتراضية تقريبية — يجب ضبطها بعد فحص HTML الفعلي للموقع.
ARCHIVE_ISSUE_SELECTOR = os.environ.get("ARCHIVE_ISSUE_SELECTOR", "a.issue-link")
# إن كان المحتوى يُحمَّل عبر JavaScript، بدّل الجالب في fetcher.py إلى Playwright
# عبر تعيين USE_PLAYWRIGHT=1.
USE_PLAYWRIGHT = os.environ.get("USE_PLAYWRIGHT", "0") == "1"

# محددات CSS لاستخراج بنود المراسيم/القرارات داخل صفحة عدد واحد.
ISSUE_ITEM_SELECTOR = os.environ.get("ISSUE_ITEM_SELECTOR", "li.decree-item, li.decision-item")

HTTP_TIMEOUT = 20
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; LegislationMonitor/1.0)",
    "Accept-Language": "ar,en;q=0.8",
}

# --- Google Sheets ---
GOOGLE_SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
GOOGLE_SERVICE_ACCOUNT_JSON = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]  # مسار الملف أو محتواه JSON
STATE_WORKSHEET_NAME = "State"
DATA_WORKSHEET_NAME = "Items"

# --- Claude API ---
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")

# --- معايير التصنيف (عدّلها بما يناسب اهتماماتك) ---
CLASSIFICATION_CRITERIA_AR = """
اعتبر البند "مهم" إذا كان يتعلق بأي مما يلي:
- القوانين والأنظمة التجارية (الشركات، الاستثمار الأجنبي، المنافسة، الإفلاس، العقود التجارية)
- القوانين والأنظمة العقارية (تملك الأراضي، التسجيل العقاري، التطوير العقاري، الإيجارات)
- امتثال المنشآت (التراخيص، السلامة، البيئة، العمل، الضرائب والرسوم، متطلبات تنظيمية على الشركات)

اعتبره "غير ذي صلة" فيما عدا ذلك (مثل: تعيينات شخصية، شؤون عسكرية، مناسبات، اتفاقيات دولية
لا تمس القطاع الخاص، تعديلات إدارية داخلية لا تؤثر على الأعمال).
"""
