// Display text is filtered before it enters snapshot.json. Captures are kept
// separately as image bytes and are the only place where money may appear.
export function scrub(text, max = 400) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[link]')
    .replace(/(?:~\/|(?<![A-Za-z0-9])\/)[^\s'"`)\]]+/g, '[path]')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secret]')
    .replace(/(?:\p{Sc}|\b(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|CNY|INR|BTC)\b)\s?\d[\d\s\u202f.,]*/giu, '[amount]')
    .replace(/\d[\d\s\u202f.,]*\s?(?:\p{Sc}|\b(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|CNY|INR|BTC|dollars?|euros?|pounds?)\b)/giu, '[amount]')
    .slice(0, max);
}
