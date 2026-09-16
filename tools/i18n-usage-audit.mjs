#!/usr/bin/env node
/**
 * Every translation key `en.json` declares must be referenced somewhere in
 * `src/`.
 *
 * WHY THIS IS NOT A KARMA SPEC. `locale-parity.spec.ts` already asserts
 * everything about the locale files that can be asserted from inside a browser:
 * it imports the two JSON documents and compares their key sets. This check
 * needs the other half of the picture — the SOURCE — and a Karma bundle has no
 * filesystem and no `require.context` under the esbuild builder. So it runs in
 * Node, from `npm run lint`, which CI already gates on.
 *
 * WHY IT EXISTS AT ALL. Parity is a relation between the two locales, so a key
 * that is dead in BOTH is perfectly parallel and passes. That is how
 * `chrome.logoAlt` and `chrome.goHome` survived a redesign that took the
 * affordance they named off the screen — and a key naming a control nobody can
 * reach is worse than clutter: it is a false record that some surface still
 * offers it. A manual audit found them late and missed them once already;
 * this is that audit as a gate.
 *
 * THE ALLOW-LIST IS FOR COMPOSED KEYS ONLY. A key built at runtime — `login`'s
 * per-provider labels are `` `login.providers.${suffix}` `` — cannot be found
 * by a literal search, and is LIVE rather than dead. Anything added here must
 * name the composition site, so the next reader can check the claim rather than
 * trust it. It is NOT a place to park a key you have not got round to deleting.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = join(root, 'src/app/core/platform/i18n/locales');

/**
 * Key PREFIXES whose leaves are composed at runtime, each with the site that
 * composes them. A prefix, not a leaf, because the whole point is that the leaf
 * names are not written down anywhere.
 */
const COMPOSED_PREFIXES = [
  // login.component.ts:162-163 — `login.providers.${suffix}` / `login.submit.${suffix}`
  'login.providers.',
  'login.submit.',
];

/**
 * Leaves that are knowingly unreferenced, each with the ticket that owns them.
 * Every entry here is a debt with a name on it; an entry with no owner is a
 * deletion somebody has not made yet.
 */
const PENDING = new Map([
  // Epic 56 — the step narration that will render it is not built yet.
  ['chat.activity.stepContact', 'Epic 56'],
]);

function leaves(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? leaves(value, path)
      : [path];
  });
}

/** Every source file a key could plausibly be written in. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
    } else if (/\.(ts|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const en = JSON.parse(readFileSync(join(localeDir, 'en.json'), 'utf8'));
const declared = leaves(en);

// One concatenated haystack rather than a per-file scan: this asks "is it
// referenced ANYWHERE", and the file it is referenced in is not part of the
// question.
const haystack = sources(join(root, 'src'))
  .filter((file) => !file.startsWith(localeDir))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const dead = declared.filter((key) => {
  if (COMPOSED_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (PENDING.has(key)) return false;
  return !haystack.includes(key);
});

// A knowingly-pending key that has since been WIRED UP is also a finding: the
// list is a record of debt, and a stale record is the failure mode this whole
// check exists to catch.
const resolved = [...PENDING.keys()].filter((key) => haystack.includes(key));

if (dead.length === 0 && resolved.length === 0) {
  console.log(`i18n usage audit: ${declared.length} keys, all referenced.`);
  process.exit(0);
}

for (const key of dead) {
  console.error(
    `i18n: "${key}" is declared in en.json and referenced nowhere in src/.\n` +
      '      Delete it from BOTH locales (removing it from one breaks locale-parity.spec.ts),\n' +
      `      or add it to ${relative(root, fileURLToPath(import.meta.url))} with the ticket that owns it.`,
  );
}
for (const key of resolved) {
  console.error(
    `i18n: "${key}" is listed as pending but IS referenced now — drop it from the PENDING list.`,
  );
}
process.exit(1);
