import yaml from 'js-yaml';

/**
 * Thrown by {@link rewriteNamespaceInYaml} when the input YAML cannot be
 * parsed, the root is not a mapping, the root lacks a `namespace` key, or
 * the caller passed an empty `destNs`. The panel's Clone handler catches
 * this class BEFORE any HTTP status branch and surfaces `err.message` in an
 * error toast — the import request never fires.
 *
 * See Story 11.5 AC 6, AC 11 for the error contract.
 */
export class CloneYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneYamlError';
  }
}

/**
 * Rewrite the document-level `namespace` field of a catalog bundle YAML
 * string, returning the re-dumped YAML with every other field unchanged.
 *
 * The v2 bundle wire format is a single root mapping:
 *
 * ```
 * namespace: src          # ← document-level, ONE key
 * user_id: null
 * entries:
 *   team-1: { kind: team, parent_namespace: src-parent, payload: {...} }
 *   agent-1: { kind: agent, ... }
 * ```
 *
 * The helper touches EXACTLY one key: the root `namespace`. It does NOT walk
 * `entries`. It does NOT touch per-entry `parent_namespace` fields (those
 * are lineage pointers — "which namespace did my ancestor live in?" — not
 * the entry's current namespace; rewriting them would corrupt ADR-006
 * parent_namespace semantics). It does NOT touch any `payload` sub-tree
 * (payloads may legitimately contain the source namespace name as a string
 * literal inside `description` / `config.name` / arbitrary user-supplied
 * fields — plain-text find-and-replace would corrupt those, per ADR-011 D5
 * step 3).
 *
 * Dump options:
 *   - `sortKeys: false` — preserves root-key order (namespace → user_id → entries).
 *   - `lineWidth: -1` — disables line wrapping so our emit matches the
 *     server's PyYAML emit cosmetically (no spurious `\n`s).
 *   - `noRefs: true` — suppresses `&anchor` / `*alias` emission on repeated
 *     payload sub-objects (the server's emit does not use anchors).
 *
 * On a successful clone import the panel re-exports `destNs` (Story 11.5
 * AC 12), so the operator ultimately sees the server's canonical emit, not
 * this helper's dump. Round-trip fidelity here just needs to be good enough
 * for the import to succeed — minor cosmetic differences (key ordering
 * inside payload, block-scalar quoting) are invisible to the user after
 * re-export.
 */
export function rewriteNamespaceInYaml(input: string, destNs: string): string {
  // Defence-in-depth: the panel's Confirm-button disabled rule prevents
  // empty destNs from ever reaching the helper, but mirror Story 11.3's
  // `savedBuffer` pattern and validate the caller-supplied string.
  if (typeof destNs !== 'string' || destNs.length === 0) {
    throw new CloneYamlError('destNs must be a non-empty string');
  }

  let parsed: unknown;
  try {
    // `yaml.load` with the default schema is a safe loader in js-yaml v4 —
    // no arbitrary-class instantiation. Leaving the schema implicit matches
    // the rest of the codebase's js-yaml usage (see ApiService if applicable
    // — here the helper stands alone).
    parsed = yaml.load(input);
  } catch (err) {
    const underlying = err instanceof Error ? err.message : String(err);
    throw new CloneYamlError(`yaml-parse-error: ${underlying}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CloneYamlError('bundle root is not a mapping');
  }

  const doc = parsed as Record<string, unknown>;
  if (typeof doc['namespace'] !== 'string') {
    throw new CloneYamlError('bundle root has no `namespace` key');
  }

  // Rewrite only the document-level namespace key — entries and payload
  // subtrees are untouched (ADR-011 D5 step 3; see docstring above).
  doc['namespace'] = destNs;

  return yaml.dump(doc, { sortKeys: false, lineWidth: -1, noRefs: true });
}
