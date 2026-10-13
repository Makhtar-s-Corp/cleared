// Registers a passkey on this device. The one-time grant comes after the # sign
// (never sent in a request line) from the address `cleared app passkey` printed
// on the machine, under the human's own account.
const fr = (navigator.language || '').startsWith('fr');
const words = fr
  ? { title: 'Enregistrer une clé d’accès', go: 'Enregistrer ce téléphone', done: 'Clé d’accès enregistrée. Vous pouvez fermer cette page.', missing: 'Ouvrez l’adresse affichée par « cleared app passkey ».', failed: 'La clé d’accès n’a pas pu être enregistrée.', insecure: 'Cette page doit être ouverte en https.' }
  : { title: 'Register a passkey', go: 'Register this phone', done: 'Passkey registered. You can close this page.', missing: 'Open the address printed by “cleared app passkey”.', failed: 'The passkey could not be registered.', insecure: 'This page must be opened over https.' };
const $ = (id) => document.getElementById(id);
const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
const text64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
document.documentElement.lang = fr ? 'fr' : 'en';
document.title = `Cleared Cockpit · ${words.title}`;
$('title').textContent = words.title; $('go').textContent = words.go;
const grant = decodeURIComponent(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
const say = (text, bad = true) => { $('err').textContent = text; $('err').hidden = false; $('err').className = bad ? 'danger' : 'success'; };
if (!grant) { $('go').hidden = true; say(words.missing); }
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
    $('go').hidden = true; say(words.done, false);
  } catch (error) { say(error.message === 'insecure' ? words.insecure : words.failed); $('go').disabled = false; }
});
