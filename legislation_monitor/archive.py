"""
استخراج قائمة أعداد الجريدة الرسمية من صفحة الأرشيف، واستخراج بنود عدد واحد.

ملاحظة: محددات CSS تقريبية (config.ARCHIVE_ISSUE_SELECTOR / ISSUE_ITEM_SELECTOR)
ويجب ضبطها بعد فحص HTML الفعلي لصفحات qanoon.om.
"""

import re
from dataclasses import dataclass
from urllib.parse import urljoin

import config
from fetcher import get_soup


@dataclass
class IssueRef:
    number: str
    date: str
    url: str


@dataclass
class LegalItem:
    issue_number: str
    issue_date: str
    item_type: str  # "مرسوم سلطاني" أو "قرار وزاري"
    title: str
    url: str


def get_latest_issue() -> IssueRef:
    """يرجع أحدث عدد مذكور في صفحة الأرشيف (أول عنصر يطابق المحدد)."""
    soup = get_soup(config.ARCHIVE_URL)
    links = soup.select(config.ARCHIVE_ISSUE_SELECTOR)
    if not links:
        raise RuntimeError(
            "لم يتم العثور على أي رابط عدد بمحدد CSS الحالي — "
            "راجع ARCHIVE_ISSUE_SELECTOR في config.py مقابل HTML الفعلي للموقع."
        )
    first = links[0]
    href = urljoin(config.ARCHIVE_URL, first.get("href", ""))
    text = first.get_text(strip=True)

    number_match = re.search(r"\d+", text)
    number = number_match.group(0) if number_match else text

    date_match = re.search(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", text)
    date = date_match.group(0) if date_match else ""

    return IssueRef(number=number, date=date, url=href)


def get_issue_items(issue: IssueRef) -> list[LegalItem]:
    """يستخرج قائمة المراسيم/القرارات من صفحة عدد محدد."""
    soup = get_soup(issue.url)
    nodes = soup.select(config.ISSUE_ITEM_SELECTOR)

    items = []
    for node in nodes:
        link = node.find("a")
        title = (link or node).get_text(strip=True)
        url = urljoin(issue.url, link.get("href", "")) if link else issue.url

        if "مرسوم" in title:
            item_type = "مرسوم سلطاني"
        elif "قرار" in title:
            item_type = "قرار وزاري"
        else:
            item_type = "أخرى"

        items.append(
            LegalItem(
                issue_number=issue.number,
                issue_date=issue.date,
                item_type=item_type,
                title=title,
                url=url,
            )
        )
    return items
