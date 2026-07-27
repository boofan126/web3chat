// SPDX-License-Identifier: Apache-2.0
// 中文/EN 切换 + 持久化到 localStorage（原 policy.html 尾部内联块，P0-#3 外置）
(function () {
  var KEY = 'sibyx_policy_lang';
  var btns = document.querySelectorAll('.lang-btn');
  function apply(lang) {
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.lang = (lang === 'zh') ? 'zh-CN' : 'en';
    btns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-lang') === lang); });
  }
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      var l = b.getAttribute('data-lang');
      try { localStorage.setItem(KEY, l); } catch (e) {}
      apply(l);
    });
  });
  // 初始化：与 head 内联脚本一致，确保按钮高亮正确
  var cur = document.documentElement.getAttribute('data-lang') || 'en';
  apply(cur);
})();
