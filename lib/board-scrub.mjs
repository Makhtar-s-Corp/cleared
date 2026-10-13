// Whatever text comes from a tool, a ticket or a log: no absolute path, no
// long secret-looking string, no control character, bounded length.
export function scrub(text, max = 400) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/(?:~|\/(?:home|root|tmp|var|etc|usr|opt|srv|mnt|run|Users))[^\s'"`)\]]*/g, '[path]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[credentials]@')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secret]')
    .replace(/(?:\b(?:USD|EUR)\s?)?\d[\d\s\u202f.,]*\d?\s?(?:\$|€|\bUSD\b|\bEUR\b|dollars?|euros?)|(?:\$|€|\bUSD\b|\bEUR\b)\s?\d[\d\s\u202f.,]*\d?/gi, '[amount]')
    .slice(0, max);
}

