"""
نقطة الدخول: يفحص هل صدر عدد جديد من الجريدة الرسمية العُمانية على qanoon.om،
وإن كان كذلك يستخرج البنود، يصنّفها ويلخّص المهم منها، ويحفظها في Google Sheet.

التشغيل: python main.py
"""

import sys

import archive
import classifier
import sheets_client


def run() -> None:
    latest = archive.get_latest_issue()
    last_seen = sheets_client.get_last_seen_issue()

    if last_seen == latest.number:
        print(f"لا جديد. آخر عدد مرصود: {last_seen}")
        return

    print(f"عدد جديد: {latest.number} ({latest.date}) — {latest.url}")
    items = archive.get_issue_items(latest)
    print(f"عدد البنود المستخرجة: {len(items)}")

    rows = []
    for item in items:
        try:
            classification = classifier.classify_item(item)
        except Exception as exc:  # نتجاوز البند عند فشل التصنيف بدل إيقاف كل التشغيل
            print(f"تعذّر تصنيف: {item.title} — {exc}", file=sys.stderr)
            continue

        is_relevant = classification.get("relevant", False)
        reason = classification.get("reason", "")

        summary = impact = ""
        if is_relevant:
            try:
                result = classifier.summarize_item(item)
                summary = result.get("summary", "")
                impact = result.get("impact", "")
            except Exception as exc:
                print(f"تعذّر تلخيص: {item.title} — {exc}", file=sys.stderr)

        rows.append(
            [
                item.issue_number,
                item.issue_date,
                item.item_type,
                item.title,
                item.url,
                "مهم" if is_relevant else "غير ذي صلة",
                reason,
                summary,
                impact,
            ]
        )

    sheets_client.append_items(rows)
    sheets_client.set_last_seen_issue(latest.number, latest.date)
    print(f"تم الحفظ. البنود المهمة: {sum(1 for r in rows if r[5] == 'مهم')}")


if __name__ == "__main__":
    run()
