// Switch the colour theme in one frame. Colour transitions on controls would otherwise lag behind the page
// background for their 150ms and the switch would ripple across the screen.
export function setThemeAttr(t) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.dataset.theme = t;
  void root.offsetWidth; // apply the new colours before transitions come back
  requestAnimationFrame(() => root.classList.remove('theme-switching'));
}
