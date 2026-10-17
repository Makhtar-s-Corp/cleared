// Registers a passkey on this device. The one-time grant comes after the # sign
// (never sent in a request line) from the address `cleared app passkey` printed
// on the machine, under the human's own account.
const $ = (id) => document.getElementById(id);
const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
const text64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const grant = decodeURIComponent(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
// The messages are already on the page, in the owner's language: this only shows the right one.
const say = (which) => { for (const line of document.querySelectorAll('.say')) line.hidden = line.id !== `say-${which}`; };
if (!grant) { $('go').hidden = true; say('missing'); }
$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    if (!window.PublicKeyCredential) throw new Error('insecure');
    const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    const post = async (path, body) => {
      const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    const { publicKey: k } = await post('/api/passkeys/options', { grant });
    const made = await navigator.credentials.create({ publicKey: { ...k, challenge: bytes(k.challenge), user: { ...k.user, id: bytes(k.user.id) }, excludeCredentials: k.excludeCredentials.map((c) => ({ ...c, id: bytes(c.id) })) } });
    await post('/api/passkeys/finish', { grant, name: me.device, credential: { id: made.id, response: { clientDataJSON: text64(made.response.clientDataJSON), attestationObject: text64(made.response.attestationObject) } } });
    $('go').hidden = true; say('done');
  } catch (error) { say(error.message === 'insecure' ? 'insecure' : 'failed'); $('go').disabled = false; }
});
