"""
تصنيف وتلخيص بنود المراسيم/القرارات عبر Claude API.
"""

import json

import anthropic

import config
from archive import LegalItem

_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

_CLASSIFY_SYSTEM = f"""أنت محلل تشريعي متخصص. مهمتك تصنيف بند تشريعي عُماني واحد فقط
بناءً على المعايير التالية:

{config.CLASSIFICATION_CRITERIA_AR}

أجب حصراً بكائن JSON بالشكل التالي، بدون أي نص إضافي:
{{"relevant": true|false, "reason": "سبب مختصر بالعربي"}}
"""

_SUMMARIZE_SYSTEM = """أنت محلل تشريعي. اكتب ملخصاً موجزاً بالعربي (3-5 أسطر) لبند تشريعي عُماني،
يليه فقرة منفصلة بعنوان "الأثر المحتمل" تشرح تأثيره العملي على الشركات/العقارات/الامتثال
حسب طبيعة البند. أجب حصراً بكائن JSON بالشكل التالي، بدون أي نص إضافي:
{"summary": "...", "impact": "..."}
"""


def classify_item(item: LegalItem) -> dict:
    message = _client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=300,
        system=_CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content": f"عنوان البند: {item.title}\nالنوع: {item.item_type}"}],
    )
    return json.loads(message.content[0].text)


def summarize_item(item: LegalItem) -> dict:
    message = _client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=600,
        system=_SUMMARIZE_SYSTEM,
        messages=[{"role": "user", "content": f"عنوان البند: {item.title}\nالنوع: {item.item_type}\nالرابط: {item.url}"}],
    )
    return json.loads(message.content[0].text)
