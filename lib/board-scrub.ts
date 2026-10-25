// Display text is filtered before it enters snapshot.json. Captures are kept
// separately as image bytes and are the only place where money may appear.
export function scrub(text: unknown, max = 400): string {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[link]')
    .replace(/(?:~|(?<![\w.])\.{1,2})?(?<![A-Za-z0-9])\/[^\s'"`)\]]+/g, '[path]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[secret]')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secret]')
    .replace(/(?:(?:\b(?:US|CA|AU)\s?)?\p{Sc}|\b(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|CNY|INR|BTC)\b)\s*[-+−]?\s*\d[\d\s .,]*(?:\s?(?:k|K|m|M|b|B|mio|Mio|bn|Md|Mrd|mln|thousands?|millions?|milliards?)\b)?/giu, '[amount]')
    // A currency word after the number: "5 millions d'euros", "5 millions de euros", "500 yen", "5usd" with no space.
    .replace(/[-+−]?\s*\d[\d\s .,]*\s?(?:(?:k|K|m|M|b|B|mio|Mio|bn|Md|Mrd|mln|thousands?|millions?|milliards?)\s?)?(?:(?:US|CA|AU)\s?)?(?:\p{Sc}|(?<!\p{L})(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|CNY|INR|BTC)(?!\p{L})|(?:d['’]|de\s)?\b(?:dollars?|euros?|pounds?|yen|yuans?|francs?|roubles?|rupees?)\b)/giu, '[amount]')
    .slice(0, max);
}
