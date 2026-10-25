const err = document.getElementById('err');
try { const saved = localStorage.getItem('cleared-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch { /* light */ }
async function enter(token) {
  const response = await fetch('/session', { method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  if (response.status === 204) {
    history.replaceState(null, '', '/login');
    // Coming from a notification: open the ticket it named.
    location.replace(ticket ? `/#ticket=${encodeURIComponent(ticket)}` : '/'); return;
  }
  err.hidden = false;
}
const fromHash = decodeURIComponent(location.hash.slice(1));
// A notification's address (#ticket=EX-12) is not a token: it is kept and opened after the sign-in.
let ticket = '';
if (/^ticket=[A-Za-z0-9._-]{1,40}$/.test(fromHash)) { ticket = fromHash.slice(7); history.replaceState(null, '', location.pathname); }
else if (fromHash) { history.replaceState(null, '', location.pathname); enter(fromHash); }
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); enter(document.getElementById('t').value.trim()); });
