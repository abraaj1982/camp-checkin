// Shared header text for every screen (camp name + date), follows the page language.
// Edit the camp name/date here once and every screen updates.
(function () {
  var CAMP = { ar: { t: 'مخيم نشاط التدريس ١٣', s: '30 ديسمبر 2026 – 2 يناير 2027' }, en: { t: 'Teaching Activity Camp 13', s: '30 Dec 2026 – 2 Jan 2027' } };
  function paint() {
    var l = document.documentElement.lang === 'en' ? 'en' : 'ar';
    var a = document.getElementById('campT'), b = document.getElementById('campS');
    if (a) a.textContent = CAMP[l].t;
    if (b) b.textContent = CAMP[l].s;
  }
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
