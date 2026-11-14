// Shared header text for every screen (camp name + date), follows the page language.
// Edit the camp name/date here once and every screen updates.
(function () {
  var CAMP = { ar: { t: 'المخيّم الطلابي', s: '27 ديسمبر 2026' }, en: { t: 'Student Camp', s: '27 December 2026' } };
  function paint() {
    var l = document.documentElement.lang === 'en' ? 'en' : 'ar';
    var a = document.getElementById('campT'), b = document.getElementById('campS');
    if (a) a.textContent = CAMP[l].t;
    if (b) b.textContent = CAMP[l].s;
  }
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();

// TEST BRANCH ONLY: a visible ribbon so nobody mistakes this copy for production.
(function () {
  function ribbon() {
    if (document.getElementById('testRibbon')) return;
    var d = document.createElement('div'); d.id = 'testRibbon';
    d.textContent = '🧪 نسخة تجريبية · Test copy';
    d.style.cssText = 'position:fixed;bottom:0;inset-inline:0;z-index:99999;background:#7A4308;color:#fff;text-align:center;font:600 12.5px system-ui,sans-serif;padding:5px 8px;pointer-events:none;opacity:.92';
    document.body.appendChild(d);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ribbon); else ribbon();
})();
