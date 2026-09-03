# ⚠️ هذا المجلد موقع مؤقت

مشروع **محلل الأسواق** (Market Analyst) لا علاقة له بنظام مخيم الحافلات الموجود
في جذر هذا المستودع. وُضع هنا لسبب واحد فقط: **حفظ العمل** — بيئة التطوير التي
بُني فيها مؤقتة وتُمسح بعد انتهاء الجلسة، ولم تكن صلاحية إنشاء مستودع جديد
متاحة وقت البناء (`403: Resource not accessible by integration`).

## الخطوة التالية

1. أنشئ مستودعاً جديداً فارغاً على GitHub باسم `market-analyst` (بدون README).
2. انقله إليه:

```bash
git clone https://github.com/abraaj1982/camp-checkin.git tmp
cd tmp && git checkout claude/professional-system-plan-nydfwi
cd market-analyst
rm WHERE-THIS-LIVES.md
git init -b main && git add -A
git commit -m "Import market analyst platform"
git remote add origin https://github.com/abraaj1982/market-analyst.git
git push -u origin main
```

3. احذف هذا المجلد من فرع `claude/professional-system-plan-nydfwi`.

## للتشغيل الفوري (بدون أي نقل)

انسخ مجلد `market-analyst` إلى جهازك وانقر نقراً مزدوجاً على `run-demo.bat`.
يعمل بلا إنترنت وبلا أي مفاتيح.
