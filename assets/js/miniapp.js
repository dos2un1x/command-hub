/**
 * 右下角小程序入口:默认展开,可在当前页面收起或再次展开。
 * 服务端已渲染按钮与面板;脚本只负责切换 open 类与 aria 状态。
 */
(() => {
  const root = document.querySelector('[data-miniapp]');
  if (!root) return;

  const toggle = root.querySelector('.miniapp-toggle');
  const panel = root.querySelector('.miniapp-panel');
  const close = root.querySelector('.miniapp-close');
  let open = root.classList.contains('open');

  const apply = (next) => {
    open = next;
    root.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
  };

  toggle.addEventListener('click', () => apply(!open));
  close.addEventListener('click', () => {
    apply(false);
    toggle.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') {
      apply(false);
      toggle.focus();
    }
  });
})();
