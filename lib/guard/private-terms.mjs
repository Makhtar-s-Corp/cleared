// Detects the owner's private terms (names, places, amounts) by SHA-256
// fingerprint, so the repository never stores them in clear text.
//   node scripts/private-terms.mjs hash < terms.txt > scripts/private-terms.json
//   node scripts/private-terms.mjs scan file…
//   node scripts/private-terms.mjs allow <public term>   (fingerprint for codex-guard-allow.json)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SALT = "getseetu-private-terms:v1:";
const MAX_WORDS = 4;

export const fingerprint = (term) =>
  createHash("sha256").update(SALT + term).digest("hex");

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
  const allowed = new Set(JSON.parse(readFileSync(allowPath, "utf8")));
  return new Set(JSON.parse(readFileSync(path, "utf8")).filter((hash) => !allowed.has(hash)));
};

/** Returns the distinct candidates of `text` whose fingerprint is listed. */
export function findPrivateTerms(text, fingerprints = loadFingerprints()) {
  const found = new Set();
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
      JSON.stringify([...new Set(terms.map(fingerprint))].sort(), null, 2) + "\n",
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
