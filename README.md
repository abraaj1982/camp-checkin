# 🏕️ Camp Check-In System

منظومة رقمية احترافية لإدارة حافلات المخيم الطلابي

---

## 🎯 نظرة عامة

نظام متكامل لتسجيل دخول وخروج الطلبة من الحافلات باستخدام تقنية QR Code مع لوحة تحكم حية تعرض الإحصائيات الفورية.

---

## 🔗 الروابط الرئيسية

### 📱 **تطبيق المشرفين (Supervisor App)**
للمشرفين الخمسة لتسجيل العمليات:
```
https://abraaj1982.github.io/camp-checkin/supervisor_app_professional.html
```

**المميزات:**
- ✅ مسح QR Code من الكاميرا
- ✅ إدخال رقم الطالب يدويأً
- ✅ عرض صورة وبيانات الطالب
- ✅ تسجيل Check-In / Check-Out / Withdrawn
- ✅ تحذيرات من التكرار
- ✅ ملاحظات إضافية
- ✅ تصميم SAP FIORI احترافي

---

### 📊 **لوحة التحكم (Dashboard)**
للقائد ورئيس الفريق لمراقبة الإحصائيات:
```
https://abraaj1982.github.io/camp-checkin/dashboard_v3.html
```

**المميزات:**
- 📈 إحصائيات حية Real-Time
- 👥 عدد الطلبة الكلي
- ✅ عدد الموجودين في الباص الآن (On Bus)
- ⏳ عدد المنتظرين (Waiting)
- 🚪 عدد من غادر الباص (Left)
- ⛔ عدد المنسحبين (Withdrawn)
- ⚠️ تنبيه المسح المكرر لنفس الطالب (Duplicates) - مبني على سجل CheckInLog
- 🕒 سجل آخر العمليات (Recent Activity)
- 🚌 توزيع الطلبة على الباصات مع الشواغر المتبقية
- 📊 نسب الإشغال لكل باص
- 🔄 تحديث تلقائي كل 15 ثانية

---

### 👕 **توزيع الأقمصة (Shirt Distribution)**
لتوزيع الأقمصة على الطلبة والمشرفين وتتبع المخزون لحظياً (S / M / L / XL):
```
https://abraaj1982.github.io/camp-checkin/shirt_distribution.html
```

**المميزات:**
- 📦 مخزون حي لكل مقاس (S/M/L/XL) مع تنبيه Low Stock / Out of Stock
- 🔍 بحث عن الطالب بالاسم أو الرقم، واختيار سريع للمشرفين الخمسة
- 👕 اختيار المقاس وقت التسليم (يظهر المقاس المسجل مسبقاً ويمكن تغييره)
- 📊 جدول Roster يعرض كل الأسماء مع حالتها (✅ استلم / ⏳ بالانتظار) وفلترة وبحث
- 🔒 قفل يمنع تسليم قميصين لنفس الشخص (باستخدام LockService لمنع التعارض بين مشرفين في نفس اللحظة)
- 🔄 تحديث تلقائي كل 30 ثانية، ونفس تسجيل دخول المشرف المستخدم في تطبيق الـ Check-In

---

## 🛠️ البيانات الفنية

### Google Sheet:
**رابط البيانات الأصلي:**
```
https://docs.google.com/spreadsheets/d/1N1ZZtUyxAKfyc9UbqI0qfzhB8BLbk4abo60jCkEmHPE/edit
```

### الأعمدة:
| العمود | الاسم | البيانات |
|--------|-------|---------|
| A | Student ID | رقم الطالب |
| B | Name | اسم الطالب |
| C | Team name | اسم الفريق |
| D | Bus number | رقم الباص |
| E | Contact number | رقم الاتصال |
| F | Class | الصف |
| G | Photo URL | صورة الطالب |
| H | Check-In Time | وقت الدخول |
| I | Check-Out Time | وقت الخروج |
| J | Status | الحالة |

### 👕 إعداد شيت توزيع الأقمصة (مطلوب مرة واحدة فقط)

أضف الأعمدة والشيتات التالية في نفس Google Sheet:

**1. أعمدة إضافية في شيت "Bus" (بعد العمود J):**
| العمود | الاسم | البيانات |
|--------|-------|---------|
| K | Shirt Size | مقاس القميص المسجل للطالب (S/M/L/XL) |
| L | Shirt Given At | وقت التسليم (فارغ = لم يُسلَّم بعد) |
| M | Shirt Given By | اسم المشرف الذي سلّم القميص |

**2. شيت جديد باسم "Supervisors":**
| A: Name | B: Shirt Size | C: Shirt Given At | D: Shirt Given By |
|---------|----------------|--------------------|---------------------|
| Yasser Mustafa | M | | |
| Mohammed Ismail | L | | |
| ... | | | |

**3. شيت جديد باسم "ShirtInventory" (المخزون الابتدائي لكل مقاس):**
| A: Size | B: Initial Stock | C: Low Stock Threshold |
|---------|-------------------|--------------------------|
| S | 60 | 10 |
| M | 100 | 15 |
| L | 100 | 15 |
| XL | 40 | 10 |

**4. شيت "ShirtLog"**: يُنشأ تلقائياً عند أول عملية تسليم (سجل تدقيق كامل).

**5. تحديث Google Apps Script:** افتح محرر Apps Script المرتبط بهذا الـ Sheet، وأضف التعديلين التاليين من ملف `AppsScript_Final_v2.gs` في هذا المستودع:
   - داخل `doPost`: السطر الذي يتحقق من `data.requestType === 'shirt'` قبل استدعاء `saveCheckInOut` — هذا لا يغيّر سلوك تسجيل الحافلات القديم إطلاقاً.
   - كل الدوال الجديدة في نهاية الملف (`distributeShirt`, `giveStudentShirt`, `giveSupervisorShirt`, `logShirt`).

   ثم من **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** حتى يبقى نفس رابط الـ Web App المستخدم في كل الصفحات ساري المفعول مع الكود الجديد.

---

### الباصات:
- 🚌 Bus 1
- 🚌 Bus 2
- 🚌 Bus 3
- 🚌 Bus 4
- 🚌 Bus 5

### المشرفون:
1. Yasser Mustafa
2. Mohammed Ismail
3. Abbas Abdul Rab
4. Hussain Mustafa
5. Hamza

---

## 📝 الملفات في المشروع

```
camp-checkin/
├── README.md                          # هذا الملف
├── supervisor_app_professional.html   # تطبيق المشرفين (مسح QR + Check-In/Out)
├── dashboard_v3.html                  # لوحة التحكم (تشمل مخزون الأقمصة)
├── shirt_distribution.html            # توزيع الأقمصة S/M/L/XL + مخزون حي + Roster
├── qr_codes_ready.html                # توليد QR Codes للطباعة (بيانات تجريبية)
└── AppsScript_Final_v2.gs             # Google Apps Script (Backend)
```

---

## 🚀 كيفية الاستخدام

### للمشرفين:
1. افتح رابط التطبيق من الهاتف
2. اختر اسمك من القائمة (مرة واحدة فقط)
3. امسح QR Code أو أدخل رقم الطالب
4. اختر نوع العملية (Check-In / Check-Out / Withdrawn)
5. أضف ملاحظة إذا لزم الأمر
6. تأكد من تسجيل العملية

### للقائد:
1. افتح Dashboard من الحاسوب أو الجوال
2. شاهد الإحصائيات المحدثة كل 15 ثانية
3. راقب توزيع الطلبة على الباصات
4. تحقق من الطلبة المكررين

---

## 🔧 التكنولوجيا المستخدمة

- **Frontend:** HTML5 + CSS3 + JavaScript (Vanilla)
- **Backend:** Google Apps Script
- **Database:** Google Sheets
- **Hosting:** GitHub Pages
- **Design:** SAP FIORI
- **QR Code:** html5-qrcode library
- **Icons:** Emojis
- **Fonts:** Google Fonts (Roboto)

---

## 📊 الإحصائيات

- **إجمالي الطلبة:** 300+
- **عدد الباصات:** 5
- **المشرفون:** 5
- **معدل التحديث:** 15 ثانية

---

## ✅ الحالات المدعومة

### Status Values:
- ✅ **In Bus** - في الباص (تم التسجيل)
- ⏳ **Waiting** - في الانتظار (لم يسجل بعد)
- 🏕️ **In Camp** - في المخيم (وصل)
- 🚪 **Left** - غادر
- ⛔ **Withdrawn** - منسحب

---

## 🐛 معالجة الأخطاء

### المشكلات الشائعة وحلولها:

1. **Dashboard لا يعرض البيانات**
   - اضغط Ctrl+Shift+R لحذف الـ Cache
   - تأكد من الاتصال بالإنترنت
   - تحقق من أن Google Sheet عام (Public)

2. **QR Scanner لا يعمل**
   - تأكد من إعطاء صلاحيات الكاميرا
   - استخدم متصفح حديث (Chrome, Safari, Firefox)

3. **البيانات قديمة**
   - Dashboard يحدّث تلقائياً كل 15 ثانية
   - اضغط F5 لإعادة التحميل

---

## 📞 الدعم والمساعدة

للمشاكل والاقتراحات:
1. تحقق من الاتصال بالإنترنت
2. امسح الـ Cache (Ctrl+Shift+R)
3. جرّب على متصفح مختلف
4. تواصل مع مسؤول النظام

---

## 📅 آخر تحديث
**30 أغسطس 2026**

---

## 🎓 المشروع
**مشروع إدارة حافلات المخيم الطلابي**

---

## 📄 الترخيص
جميع الحقوق محفوظة © 2026
