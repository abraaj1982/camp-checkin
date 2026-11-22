// FICTIONAL student list for the LOAD sheet only. Prints a tab-separated table to paste into cell A1 of the "Bus" tab
// of the NEW, EMPTY LOAD spreadsheet (never TEST, never production).
// Usage: node tests/load/load-data.js > tests/load/results/load_students.tsv
const HEAD = ['Class', 'Name', 'Bus number', 'Student ID', 'Team name', 'Contact number', 'Photo URL', 'Food allergy', 'Shirt size', 'Bags', 'Medical notes'];
const first = ['محمد', 'أحمد', 'علي', 'حسن', 'حسين', 'يوسف', 'إبراهيم', 'عبدالله', 'خالد', 'سالم', 'سعيد', 'ناصر', 'مصطفى', 'مهدي', 'صادق', 'جعفر', 'باقر', 'عباس', 'زيد', 'عمر'];
const SUFFIX = 'التجريبي';
function students(n, buses) { n = n || 300; buses = buses || 8; const rows = [];
  for (let i = 0; i < n; i++) rows.push([String(5 + i % 4), first[i % 20] + ' ' + first[(i * 3 + 1) % 20] + ' ' + first[(i * 7 + 3) % 20] + ' ' + SUFFIX + ' ' + (i + 1), String(1 + i % buses), String(1001 + i), ['الأزرق', 'الأحمر', 'الأخضر', 'الأصفر'][i % 4], '99990000', '', i % 9 === 0 ? 'فول سوداني' : '', ['S', 'M', 'L', 'XL'][i % 4], i % 3 === 0 ? 0 : 1, i % 15 === 0 ? 'ربو خفيف' : '']);
  return rows; }
// The LOAD run refuses to write anything unless EVERY student looks like this (protects against a real sheet).
const looksFictional = list => list.length > 0 && list.every(s => String(s.name).indexOf(SUFFIX) !== -1 && /^\d{4}$/.test(String(s.id)));
module.exports = { HEAD, students, looksFictional, SUFFIX };
if (require.main === module) { console.log([HEAD].concat(students()).map(r => r.join('\t')).join('\n')); }
