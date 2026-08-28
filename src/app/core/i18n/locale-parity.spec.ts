import en from './locales/en.json';
import fr from './locales/fr.json';

/**
 * Every shipped locale must define exactly the keys the built-in one does.
 *
 * A *missing* key is caught at runtime by the fallback chain, so this spec is
 * not about correctness — it is about noticing. Without it, adding a key to
 * `en.json` and forgetting `fr.json` silently ships a French UI with an English
 * word in it, and nothing fails until a user reads it.
 *
 * A key present in a translation but **not** in `en.json` is the more
 * interesting failure: it is dead weight at best, and at worst it is a key
 * somebody renamed on one side only.
 *
 * This asserts on key *sets*, never on values. Asserting that `fr.common.save`
 * says anything in particular would pin the translation, which is NFR3's whole
 * complaint applied to French.
 */

type Dict = Record<string, unknown>;

/** Flatten to dotted leaf paths, so a section moved is reported as its leaves. */
function leafKeys(dict: Dict, prefix = ''): string[] {
  return Object.entries(dict).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? leafKeys(value as Dict, path)
      : [path];
  });
}

describe('shipped locales', () => {
  const builtIn = leafKeys(en as Dict).sort();

  it('the built-in locale is not empty, which would make this spec vacuous', () => {
    expect(builtIn.length).toBeGreaterThan(0);
  });

  const locales: Record<string, Dict> = { fr: fr as Dict };

  for (const [lang, dict] of Object.entries(locales)) {
    describe(lang, () => {
      const keys = leafKeys(dict).sort();

      it('defines every key the built-in locale defines', () => {
        expect(builtIn.filter((key) => !keys.includes(key))).toEqual([]);
      });

      it('defines no key the built-in locale does not', () => {
        expect(keys.filter((key) => !builtIn.includes(key))).toEqual([]);
      });

      it('has no empty string, which would render blank rather than fall back', () => {
        // The fallback chain only fires on a *missing* key. An empty string is
        // present, so it wins, and the label disappears. FR3 in reverse.
        const flat = flatten(dict);
        expect(Object.keys(flat).filter((key) => flat[key].trim() === '')).toEqual([]);
      });
    });
  }
});

function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Dict, path));
    } else {
      out[path] = String(value);
    }
  }
  return out;
}
