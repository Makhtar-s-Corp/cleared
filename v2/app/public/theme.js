// Loaded as a classic script in <head>, before the page paints: it applies
// the theme the person chose with the button (light unless they chose dark;
// never the system's setting). Storage may be unavailable: light then.
// Plain JavaScript, served as it is, so it runs before the bundle loads.
{
  let theme = null;
  try {
    theme = localStorage.getItem('cleared-v2-theme');
  } catch {
    theme = null;
  }
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}
