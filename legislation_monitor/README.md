# أداة رصد التشريعات العُمانية (qanoon.om)

يفحص السكربت دورياً هل صدر عدد جديد من الجريدة الرسمية على qanoon.om، يستخرج
عناوين المراسيم السلطانية والقرارات الوزارية، يصنّفها عبر Claude API حسب
معايير محددة (تجاري/عقاري/امتثال منشآت)، يلخّص المهم منها بالعربي مع فقرة
"الأثر المحتمل"، ويحفظ كل شيء في Google Sheet.

## ⚠️ خطوة أولى مطلوبة قبل أي تشغيل

محددات CSS في `config.py` (`ARCHIVE_ISSUE_SELECTOR`, `ISSUE_ITEM_SELECTOR`)
**تقريبية وغير مُتحقق منها** — لم نتمكن من الوصول إلى qanoon.om من بيئة
التطوير الحالية (محجوب على مستوى الشبكة). يجب:

1. فتح صفحة أرشيف الأعداد على qanoon.om في المتصفح، وعرض المصدر (Ctrl+U).
2. تحديد المحدد الصحيح لرابط كل عدد (وسم `<a>` وصنفه/معرّفه).
3. فتح صفحة عدد واحد وتحديد محدد عناصر المراسيم/القرارات بنفس الطريقة.
4. تحديث القيم في `config.py` أو تمريرها كمتغيرات بيئة
   (`ARCHIVE_ISSUE_SELECTOR`, `ISSUE_ITEM_SELECTOR`).
5. إذا لم تظهر العناوين في "عرض المصدر" (فقط عناصر HTML فارغة/JS)، فعّل
   `USE_PLAYWRIGHT=1` وأضف `playwright` إلى `requirements.txt` (موجود معلّقاً).

## الإعداد

### 1. Google Sheet + Service Account
- أنشئ مشروع Google Cloud، فعّل Google Sheets API، أنشئ Service Account،
  حمّل مفتاح JSON.
- شارك الشيت المستهدف (Editor) مع بريد الـ Service Account (`client_email`
  في ملف JSON).
- الشيت سيُنشئ تلقائياً تبويبين عند أول تشغيل: `State` (لتخزين آخر عدد
  مرصود لمنع التكرار) و `Items` (لسجل كل البنود المستخرجة).

### 2. أسرار GitHub Actions (Settings → Secrets → Actions)
| السر | القيمة |
|---|---|
| `GOOGLE_SHEET_ID` | معرّف الشيت (من رابطه) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | محتوى ملف JSON كاملاً كنص |
| `ANTHROPIC_API_KEY` | مفتاح Claude API |

### 3. الجدولة
`.github/workflows/legislation-monitor.yml` يشغّل السكربت يومياً (قابل
للتعديل)، ويمكن تشغيله يدوياً من تبويب Actions (`workflow_dispatch`).

## التشغيل محلياً
```bash
cd legislation_monitor
pip install -r requirements.txt
export GOOGLE_SHEET_ID=...
export GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json   # أو محتوى JSON مباشرة
export ANTHROPIC_API_KEY=...
python main.py
```

## تخصيص معايير التصنيف
عدّل `CLASSIFICATION_CRITERIA_AR` في `config.py` بما يناسب اهتماماتك.

## قيود معروفة (TODO)
- التلخيص حالياً يعتمد على عنوان البند فقط، وليس نصه الكامل — إذا كان
  النص الكامل للمرسوم/القرار متاحاً على صفحة منفصلة في qanoon.om، يجب
  إضافة استخراج له في `archive.py` وتمريره إلى `classifier.summarize_item`
  للحصول على ملخص أدق.
- منطق استخراج رقم/تاريخ العدد في `archive.py` يعتمد على regex عام
  (أول رقم، أول نمط تاريخ) — قد يحتاج تعديلاً بعد رؤية الشكل الفعلي للنص.
