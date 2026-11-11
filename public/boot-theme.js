(function () {
  try {
    var theme = window.novoTerminal && window.novoTerminal.initialTheme;
    if (!theme) return;
    document.documentElement.setAttribute('data-boot-theme', theme);
    if (theme === 'light') document.documentElement.classList.add('theme-light');
  } catch (_) {}
})();
