// Provider-owned capture hosts. Reject redirects and credentials before the
// collector downloads anything from a ticket comment.
export function captureUrl(adapter, input) {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Invalid capture URL');
  if (adapter === 'github') {
    if (host === 'github.com') {
      const match = /^\/([^/]+)\/([^/]+)\/raw\/([a-f0-9]{40})\/(captures\/[A-Za-z0-9/._-]+)$/.exec(url.pathname);
      if (!match) throw new Error('Unexpected GitHub capture URL');
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = `/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
    } else if (host !== 'raw.githubusercontent.com') throw new Error('Capture URL is outside GitHub');
  } else if (adapter === 'linear') {
    if (!['uploads.linear.app', 'assets.linear.app', 'linear.app'].includes(host)) throw new Error('Capture URL is outside Linear');
  } else throw new Error('Remote captures are unsupported for this tracker');
  return url;
}
