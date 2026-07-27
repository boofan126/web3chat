// SPDX-License-Identifier: Apache-2.0
// 使用说明页语言切换（原 howto.html 尾部内联块，P0-#3 外置）
(function () {
  const HT = {
    zh: { title: '使用说明' },
    en: { title: 'How to Use' },
  };
  let htLang = localStorage.getItem('htLang');
  if (!htLang) {
    const prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    htLang = 'en';
    for (const p of prefs) {
      const l = (p || '').toLowerCase();
      if (l.startsWith('zh')) { htLang = 'zh'; break; }
      if (l.startsWith('en')) { htLang = 'en'; break; }
    }
  }
  if (!HT[htLang]) htLang = 'en';
  function applyHt() {
    document.documentElement.lang = htLang === 'zh' ? 'zh-CN' : htLang;
    document.querySelectorAll('.ht-lang').forEach(d => { d.hidden = d.dataset.lang !== htLang; });
    const t = HT[htLang].title;
    const titleEl = document.querySelector('[data-ht-title]');
    if (titleEl) titleEl.textContent = t;
    document.title = t + ' · SibyX';
    document.querySelectorAll('.ht-lang-switch .lang-btn').forEach(b => b.classList.toggle('active', b.dataset.htLang === htLang));
  }
  document.querySelectorAll('.ht-lang-switch .lang-btn').forEach(b => {
    b.addEventListener('click', () => { htLang = b.dataset.htLang; localStorage.setItem('htLang', htLang); applyHt(); });
  });
  applyHt();
})();
