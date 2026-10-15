const fr = (navigator.language || '').startsWith('fr');
const words = fr
  ? { title: 'Cleared Cockpit · connexion', msg: 'Ouvrez cette page avec votre jeton après le signe #, ou collez-le ci-dessous. Il est lu ici et envoyé dans un en-tête, jamais dans une adresse.', label: 'Jeton d’accès', open: 'Ouvrir', refused: 'Ce jeton a été refusé.' }
  : { title: 'Cleared Cockpit · sign in', msg: 'Open this page with your access token after the # sign, or paste it below. It is read here and sent in a header, never in an address.', label: 'Access token', open: 'Open', refused: 'This token was refused.' };
const err = document.getElementById('err');
document.documentElement.lang = fr ? 'fr' : 'en';
document.title = words.title;
document.getElementById('msg').textContent = words.msg;
document.querySelector('label').textContent = words.label;
document.querySelector('button').textContent = words.open;
try { const saved = localStorage.getItem('cleared-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch { /* light */ }
async function enter(token) {
  const response = await fetch('/session', { method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  if (response.status === 204) {
    history.replaceState(null, '', '/login');
    // Coming from the address that registers a passkey: go back to it, with its grant.
    if (afterRegister && grant) { try { sessionStorage.removeItem('cleared-grant'); } catch { /* nothing kept */ } location.replace(`/register#${encodeURIComponent(grant)}`); return; }
    // Coming from a notification: open the ticket it named.
    location.replace(ticket ? `/#ticket=${encodeURIComponent(ticket)}` : '/'); return;
  }
  err.textContent = words.refused; err.hidden = false;
}
const afterRegister = new URLSearchParams(location.search).get('next') === 'register';
const fromHash = decodeURIComponent(location.hash.slice(1));
// With ?next=register the # part is a passkey grant, never an access token: keep it for after the sign-in.
// A notification's address (#ticket=EX-12) is not a token either: it is kept and opened after the sign-in.
let grant = '', ticket = '';
if (afterRegister) { grant = fromHash; try { if (grant) sessionStorage.setItem('cleared-grant', grant); else grant = sessionStorage.getItem('cleared-grant') || ''; } catch { /* kept in memory only */ } history.replaceState(null, '', '/login?next=register'); }
else if (/^ticket=[A-Za-z0-9._-]{1,40}$/.test(fromHash)) { ticket = fromHash.slice(7); history.replaceState(null, '', location.pathname); }
else if (fromHash) { history.replaceState(null, '', location.pathname); enter(fromHash); }
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); enter(document.getElementById('t').value.trim()); });
