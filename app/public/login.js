const err = document.getElementById('err');
async function enter(token) {
  const response = await fetch('/session', { headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  if (response.status === 204) { history.replaceState(null, '', '/login'); location.replace('/'); return; }
  err.textContent = 'This token was refused.'; err.hidden = false;
}
const fromHash = decodeURIComponent(location.hash.replace(/^#t?=?/, ''));
if (fromHash) { history.replaceState(null, '', location.pathname); enter(fromHash); }
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); enter(document.getElementById('t').value.trim()); });
