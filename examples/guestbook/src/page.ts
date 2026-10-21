// The guestbook's only page: the entries, then the form to add one.
import type { Entry } from './store.ts';

export const LIMITS = { name: 80, message: 500 } as const;

export type FormState = {
  readonly error?: string;
  readonly name?: string;
  readonly message?: string;
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function renderEntry(entry: Entry): string {
  const at = entry.createdAt.toISOString();
  return `    <li>
      <p class="meta"><strong>${escapeHtml(entry.name)}</strong> <time datetime="${at}">${at.slice(0, 16).replace('T', ' ')} UTC</time></p>
      <p>${escapeHtml(entry.message)}</p>
    </li>`;
}

export function renderPage(entries: readonly Entry[], form: FormState = {}): string {
  const list = entries.length === 0 ? '  <p>No entries yet.</p>' : `  <ol>\n${entries.map(renderEntry).join('\n')}\n  </ol>`;
  const error = form.error ? `\n    <p role="alert">${escapeHtml(form.error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guestbook</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
    ol { list-style: none; padding: 0; }
    li { border-bottom: 1px solid #ddd; padding: 0.5rem 0; }
    li p { margin: 0.25rem 0; overflow-wrap: anywhere; }
    .meta { color: #555; font-size: 0.875rem; }
    label { display: block; margin-top: 0.75rem; }
    input, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.4rem; }
    button { margin-top: 0.75rem; font: inherit; padding: 0.4rem 1rem; }
    [role="alert"] { color: #a40000; }
  </style>
</head>
<body>
  <h1>Guestbook</h1>
${list}
  <h2>Sign the guestbook</h2>
  <form method="post" action="/entries">${error}
    <label for="name">Name</label>
    <input id="name" name="name" maxlength="${LIMITS.name}" required value="${escapeHtml(form.name ?? '')}">
    <label for="message">Message</label>
    <textarea id="message" name="message" maxlength="${LIMITS.message}" rows="3" required>${escapeHtml(form.message ?? '')}</textarea>
    <button type="submit">Sign</button>
  </form>
</body>
</html>
`;
}
