const err = document.getElementById('err');
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
  err.hidden = false;
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
