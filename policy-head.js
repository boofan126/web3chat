// SPDX-License-Identifier: Apache-2.0
// 提前按 localStorage 或浏览器语言设定，避免闪烁（原 policy.html head 内联块，P0-#3 外置）
(function () {
  try {
    var k = localStorage.getItem('sibyx_policy_lang');
    if (!k) {
      var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
      k = 'en';
      for (var i = 0; i < prefs.length; i++) {
        var l = (prefs[i] || '').toLowerCase();
        if (l.indexOf('zh') === 0) { k = 'zh'; break; }
        if (l.indexOf('en') === 0) { k = 'en'; break; }
      }
    }
    document.documentElement.setAttribute('data-lang', k);
    document.documentElement.lang = (k === 'zh') ? 'zh-CN' : 'en';
  } catch (e) {}
})();
