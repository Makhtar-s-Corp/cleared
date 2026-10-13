const fr = (navigator.language || '').startsWith('fr');
const words = fr
  ? { title: 'Cleared Cockpit · connexion', msg: 'Ouvrez cette page avec votre jeton après le signe #, ou collez-le ci-dessous. Il est lu ici et envoyé dans un en-tête, jamais dans une adresse.', label: 'Jeton d’accès', open: 'Ouvrir', refused: 'Ce jeton a été refusé.' }
  : { title: 'Cleared Cockpit · sign in', msg: 'Open this page with your access token after the # sign, or paste it below. It is read here and sent in a header, never in an address.', label: 'Access token', open: 'Open', refused: 'This token was refused.' };
document.documentElement.lang = fr ? 'fr' : 'en';
document.title = words.title;
document.getElementById('msg').textContent = words.msg;
document.querySelector('label').textContent = words.label;
document.querySelector('button').textContent = words.open;
const err = document.getElementById('err');
async function enter(token) {
  const response = await fetch('/session', { headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  if (response.status === 204) { history.replaceState(null, '', '/login'); location.replace('/'); return; }
  err.textContent = words.refused; err.hidden = false;
}
const fromHash = decodeURIComponent(location.hash.replace(/^#t?=?/, ''));
if (fromHash) { history.replaceState(null, '', location.pathname); enter(fromHash); }
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); enter(document.getElementById('t').value.trim()); });
