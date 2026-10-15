// E-mail, through the machine's own sendmail program ([notify] sendmail,
// /usr/sbin/sendmail by default: Postfix, msmtp, OpenSMTPD...). Cleared holds
// no mail password: the mail program does. The addresses are the human's
// private data, so they live in the service's private credentials file
// ("email": {"to", "from"}), never in agents.conf. The recipient is given as an
// argument (never read from the headers), and every header is encoded, so no
// text can add a header or a recipient.
import { execFileSync } from 'node:child_process';

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function emailTarget(value) {
  const to = value?.to, from = value?.from ?? value?.to;
  if (typeof to !== 'string' || !ADDRESS.test(to) || typeof from !== 'string' || !ADDRESS.test(from)) return null;
  return { to, from };
}
// RFC 2047: a header in UTF-8 that cannot carry a line break.
const encoded = (text) => `=?UTF-8?B?${Buffer.from(String(text)).toString('base64')}?=`;
const wrap = (text) => text.match(/.{1,76}/g).join('\r\n');

export function mailOf(message, { to, from }, now = new Date()) {
  const body = [message.body, message.url].filter(Boolean).join('\n\n');
  return [`From: ${encoded('Cleared')} <${from}>`, `To: <${to}>`, `Subject: ${encoded(message.title)}`, `Date: ${now.toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'Auto-Submitted: auto-generated', '',
    wrap(Buffer.from(`${body}\n`).toString('base64')), ''].join('\r\n');
}

const sendmailRun = (file, args, input) => execFileSync(file, args, { input, timeout: 15000, stdio: ['pipe', 'ignore', 'ignore'] });

export function emailAdapter({ credentials, sendmail = '/usr/sbin/sendmail', run = sendmailRun }) {
  const target = () => { try { return emailTarget(credentials()); } catch { return null; } };
  return {
    name: 'email',
    ready: () => (target() ? null : 'no_credentials'),
    async send(message) {
      const to = target();
      if (!to) throw new Error('no credentials');
      // -i: a line with a single dot does not end the message.
      try { await run(sendmail, ['-i', '-f', to.from, '--', to.to], mailOf(message, to)); }
      catch { throw new Error('sendmail failed'); }
      return { delivered: 1 };
    },
  };
}
