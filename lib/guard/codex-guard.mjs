// Refuses to hand content to an external model when it holds a private term
// (fingerprints in scripts/private-terms.json), a secret or an IBAN. Reports
// only file, line and category, never the value.
//   node scripts/codex-guard.mjs --strict <file>…   diff, brief, commits, task
//   node scripts/codex-guard.mjs --tree <dir>        every text file of a snapshot
//   node scripts/codex-guard.mjs --prune <dir>       deletes every non-text file
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { findPrivateTerms, loadFingerprints } from "./private-terms.mjs";

const fingerprints = loadFingerprints();
// Fingerprints of values checked by hand as fictitious test fixtures
// (example IBANs, fake keys): `node scripts/codex-guard.mjs --allow <value>`.
const allowPath = new URL("./codex-guard-allow.json", import.meta.url);
const allowed = new Set(JSON.parse(readFileSync(allowPath, "utf8")));
const valueFingerprint = (value) =>
  createHash("sha256").update("codex-guard:v1:" + value).digest("hex");
// Text = valid UTF-8 without NUL bytes; anything else (images, PDFs, office
// documents, archives, databases) is never exposed.
const isText = (buffer) => {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
};
// High-confidence patterns, checked everywhere.
const always = [
  ["application token", /gs_live_[A-Za-z0-9_-]{8,}/],
  ["clé API", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["clé privée", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["IBAN", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/],
  ["identifiants dans une URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@/'"`]+@/i],
  // Any address outside reserved or explicitly fictitious domains.
  [
    "adresse e-mail",
    /\b[a-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|exemple\.fr|[a-z0-9-]+\.(?:test|invalid|localhost|example))(?![a-z0-9-]|\.[a-z0-9]))[a-z0-9.-]+\.[a-z]{2,}/i,
  ],
  [
    "téléphone",
    /(?<![\d.,])(?:(?:\+|00)33 ?[1-9]|0[1-9])(?:\d{8}|(?: \d{2}){4}|(?:\.\d{2}){4})(?![\d.,])/,
  ],
  [
    "secret littéral",
    /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*(?:"(?!\$)[^"\s]{8,}"|'[^'\s]{8,}'|`(?!\$)[^`\s]{8,}`)/i,
  ],
];
// Direct inputs only (diff, brief, commits, task): looser forms that code
// legitimately uses for field names and UI labels.
const directOnly = [
  [
    "secret affecté",
    /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*["'][^"']*\s[^"']*["']/i,
  ],
  [
    "secret affecté",
    /^\s*[\w-]*(?:pass(?:word)?|secret|token|api[_-]?key|pepper)[\w-]*\s*:\s*(?![$"'{[(]|process\.env)[^\s#]{8,}/i,
  ],
];

// A line of a code file inside the lane diff gets exactly the patterns of
// the snapshot (`--tree`), where that file is sent anyway: the looser
// "direct input" forms below would only refuse in the diff what the
// snapshot already carries, and code legitimately uses them for field names
// (`apiKeySealed: sealApiKey(apiKey)`, `password: config.ownerPassword`).
// Briefs, commit messages, tasks and diff lines of any other file (YAML,
// Markdown, env…) keep every pattern.
const CODE_FILE = /\.(?:m?js|cjs|jsx|ts|tsx)$/;
// Unquoted assignments of secret-looking values, as in .env files.
const envAssignments = [
  [
    "secret affecté",
    /^\s*(?:export\s+)?(?=[A-Z])[A-Z0-9_]*(?:PASS(?:WORD)?|SECRET|TOKEN|API_?KEY|PEPPER)[A-Z0-9_]*=[^\s"'$(#]{8,}/,
  ],
];

// Never follows symbolic links: a snapshot's links are removed by --prune,
// and a link met while checking is reported, not read.
const files = (dir, withDirs = false) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? [...(withDirs ? [path] : []), ...files(path, withDirs)]
      : [path];
  });

const [mode, ...args] = process.argv.slice(2);
if (mode === "--allow") {
  for (const value of args) console.log(valueFingerprint(value));
  process.exit(0);
}
const targets = mode === "--tree" ? files(args[0], true) : args;
if (mode === "--prune") {
  for (const file of files(args[0]))
    if (lstatSync(file).isSymbolicLink() || !isText(readFileSync(file)))
      rmSync(file);
  // Directories left empty go too, so only text files' paths remain.
  for (const dir of files(args[0], true).reverse())
    if (lstatSync(dir).isDirectory() && readdirSync(dir).length === 0)
      rmSync(dir, { recursive: true });
  process.exit(0);
}
const patterns =
  mode === "--strict"
    ? [...always, ...envAssignments, ...directOnly]
    : [...always, ...envAssignments];
const snapshotPatterns = [...always, ...envAssignments];
const problems = [];
for (const file of targets) {
  // File and directory names are exposed too. A flagged name is never
  // printed, in any diagnostic of that file: only its position is.
  const name = mode === "--tree" ? file.slice(args[0].length) : "";
  const nameProblems = [];
  if (name && findPrivateTerms(name, fingerprints).length)
    nameProblems.push("terme privé dans le nom");
  if (name)
    for (const [category, pattern] of always)
      if (pattern.test(name)) nameProblems.push(`${category} dans le nom`);
  // Direct inputs are always shown by position, never by path.
  const shown =
    nameProblems.length || mode !== "--tree"
      ? `[${mode === "--tree" ? "nom masqué" : "entrée"} n° ${targets.indexOf(file) + 1}]`
      : file;
  for (const problem of nameProblems) problems.push(`${shown}: ${problem}`);
  const stat = lstatSync(file);
  if (stat.isDirectory()) continue;
  if (stat.isSymbolicLink()) {
    problems.push(`${shown}: lien symbolique`);
    continue;
  }
  const buffer = readFileSync(file);
  if (!isText(buffer)) {
    // A snapshot is pruned beforehand; a direct input must be text.
    problems.push(`${shown}: fichier non textuel`);
    continue;
  }
  const text = buffer.toString("utf8");
  if (findPrivateTerms(text, fingerprints).length)
    problems.push(`${shown}: terme privé`);
  const isDiff = /\.(?:diff|patch)$/.test(file);
  // The file a diff line belongs to: a code file gets the snapshot patterns.
  let diffFile = "";
  text.split("\n").forEach((raw, index) => {
    if (isDiff && raw.startsWith("+++ ")) diffFile = raw.slice(4).replace(/^b\//, "");
    const inCode = isDiff && CODE_FILE.test(diffFile);
    // Diff lines start with "+", "-" or a space: check the content itself.
    const line = isDiff ? raw.replace(/^[+\- ]/, "") : raw;
    for (const [category, pattern] of inCode ? snapshotPatterns : patterns) {
      const found = line.match(new RegExp(pattern.source, pattern.flags + "g")) || [];
      if (found.some((value) => !allowed.has(valueFingerprint(value))))
        problems.push(`${shown}:${index + 1}: ${category}`);
    }
  });
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error("Refusé : contenu sensible dans ce qui serait envoyé à Codex.");
  process.exit(1);
}
