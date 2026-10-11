// Detects the owner's private terms (names, places, amounts) by SHA-256
// fingerprint, so the repository never stores them in clear text.
//   node scripts/private-terms.mjs hash < terms.txt > scripts/private-terms.json
//   node scripts/private-terms.mjs scan file…
//   node scripts/private-terms.mjs allow <public term>   (fingerprint for codex-guard-allow.json)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from 'node:child_process';

function trustedProjectConfig() {
  const project = process.env.CLEARED_REPO || process.env.ORCH_REPO || process.cwd();
  let ref = process.env.ORCH_GUARD_REF;
  if (!ref) {
    try { ref = execFileSync('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim(); }
    catch { ref = 'origin/main'; }
  }
  let source = '';
  try { source = execFileSync('git', ['-C', project, 'show', `${ref}:.cleared/agents.conf`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { /* this path is not committed at the trusted ref */ }
  return { project, ref, source };
}
const trusted = trustedProjectConfig();
export function guardValue(key) {
  let guard = false;
  for (const line of trusted.source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) guard = trimmed === '[guard]';
    else if (guard && trimmed.slice(0, trimmed.indexOf('=')).trim() === key) return trimmed.slice(trimmed.indexOf('=') + 1).trim();
  }
  return '';
}
const SALT = guardValue('salt');
const MAX_WORDS = 4;
const WRONG_SALT = 'These fingerprints were made with another salt. Set [guard] salt to the salt that made them, or rebuild the list.';
export const saltId = (salt = SALT) => createHash('sha256').update(salt).digest('hex').slice(0, 12);

export const fingerprint = (term) => {
  if (!SALT) throw new Error('Missing [guard] salt');
  return createHash('sha256').update(SALT + term).digest('hex');
};

/** Lowercase, accent-free words; digit groups ("12 345", "1_234_567") are joined. */
export function normalizeWords(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/(\d)[\s_\u00a0\u202f.,](?=\d{3}(?!\d))/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Every run of one to four consecutive words, as the text would be fingerprinted. */
export function* candidates(text) {
  const words = normalizeWords(text);
  for (let start = 0; start < words.length; start++)
    for (let size = 1; size <= MAX_WORDS && start + size <= words.length; size++)
      yield words.slice(start, start + size).join(" ");
}

// A listed term that is public after all (a country, a city) is allowed by
// adding its fingerprint to codex-guard-allow.json
// (`node scripts/private-terms.mjs allow <term>`): the guard and every scan
// then skip it, and the term never appears in clear in the repository.
export const loadFingerprints = (
  path = new URL("./private-terms.json", import.meta.url),
  allowPath = new URL("./codex-guard-allow.json", import.meta.url),
) => {
  const readList = (file) => {
    let source;
    if (existsSync(file)) source = readFileSync(file, 'utf8');
    else {
      const key = String(file).includes('codex-guard-allow') ? 'allowed' : 'terms';
      const name = guardValue(key);
      if (!name || name === 'none') source = '{"disabled":true,"hashes":[]}';
      else source = execFileSync('git', ['-C', trusted.project, 'show', `${trusted.ref}:${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    const data = JSON.parse(source);
    if (data && !Array.isArray(data) && data.disabled === true && Array.isArray(data.hashes) && data.hashes.length === 0) return [];
    const hashes = Array.isArray(data) ? data : data?.hashes;
    if (!Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string')) throw new Error(`Invalid fingerprint list: ${file}`);
    if (!SALT) throw new Error('Missing committed [guard] salt: add [guard] salt = <random value> to the project agents.conf and commit it.');
    if (Array.isArray(data) || data.salt_id !== saltId()) throw new Error(WRONG_SALT);
    return hashes;
  };
  const allowed = new Set(readList(allowPath));
  return new Set(readList(path).filter((hash) => !allowed.has(hash)));
};

/** Returns the distinct candidates of `text` whose fingerprint is listed. */
export function findPrivateTerms(text, fingerprints = loadFingerprints()) {
  const found = new Set();
  if (fingerprints.size === 0) return [];
  for (const candidate of candidates(text))
    if (fingerprints.has(fingerprint(candidate))) found.add(candidate);
  return [...found];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...files] = process.argv.slice(2);
  if (command === "hash") {
    const terms = readFileSync(0, "utf8")
      .split("\n")
      .map((line) => normalizeWords(line).join(" "))
      .filter(Boolean);
    process.stdout.write(
      JSON.stringify({ salt_id: saltId(), hashes: [...new Set(terms.map(fingerprint))].sort() }, null, 2) + "\n",
    );
  } else if (command === "allow") {
    // Fingerprint to add to codex-guard-allow.json for a public term.
    for (const term of files) console.log(fingerprint(normalizeWords(term).join(" ")));
  } else if (command === "scan") {
    let failed = false;
    for (const file of files) {
      const found = findPrivateTerms(readFileSync(file, "utf8"));
      if (found.length) {
        failed = true;
        console.log(`${file}: ${found.join(", ")}`);
      }
    }
    process.exitCode = failed ? 1 : 0;
  } else {
    console.error("Usage: node scripts/private-terms.mjs hash|allow|scan …");
    process.exitCode = 2;
  }
}
