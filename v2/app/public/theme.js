// Loaded as a classic script in <head>, before the page paints: the app has
// one theme, light, whatever the system's setting (the owner's rule, issue
// #451). An old choice of the dark theme (cleared-v2-theme) is forgotten.
// Plain JavaScript, served as it is, so it runs before the bundle loads.
{
  try {
    localStorage.removeItem('cleared-v2-theme');
  } catch {
    // storage unavailable: nothing was kept
  }
  document.documentElement.dataset.theme = 'light';
}
