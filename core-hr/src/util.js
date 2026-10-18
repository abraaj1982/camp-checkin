// مسافة هافرساين بالمتر
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// أيام العمل بين تاريخين شاملين. عطلة نهاية الأسبوع في عُمان: الجمعة والسبت
function workingDays(start, end, weekend = [5, 6], holidays = []) {
  let n = 0;
  const d = new Date(start + 'T00:00:00Z'), e = new Date(end + 'T00:00:00Z');
  for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!weekend.includes(d.getUTCDay()) && !holidays.includes(iso)) n++;
  }
  return n;
}

// الوقت المحلي لعُمان (UTC+4) لتحديد "اليوم" وساعة الدوام
function omanNow(date = new Date()) {
  const l = new Date(date.getTime() + 4 * 3600 * 1000);
  const iso = l.toISOString();
  return { date: iso.slice(0, 10), minutes: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

module.exports = { distanceM, isDate, workingDays, omanNow };
