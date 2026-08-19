/**
 * API-key data models — map to the auth backend's DTOs.
 */

/**
 * One API key as the server describes it, returned by `GET /auth/apikeys`.
 *
 * WHY THIS LIVES IN `protocol/` AND NOT UNDER THE PANE. It is imported by
 * `core/http/api.service.ts`, and the ESLint boundaries rule permits
 * `core -> protocol | shared` only. A DTO under `components/admin/` would be a
 * `core -> page` edge and fails `npm run lint` — the same violation that moved
 * `catalog.interface.ts` here. The pane keeps its own `api-key.model.ts` for
 * the types only it renders; re-exporting this one through that file would be
 * the same forbidden edge wearing a hat.
 *
 * IT CARRIES NO SECRET MATERIAL, and that is a contract rather than an
 * oversight: the list response never includes `key_hash` or a plaintext key.
 * The one plaintext-bearing DTO belongs to create/rotate (Story 36-6) and is a
 * different type, seen once, never listed.
 *
 * * `owner_email` — may be blank for a machine identity, which is why the
 *   table falls back to `owner_id` rather than rendering an empty cell.
 * * `expiration` — ISO-8601, or `null` for a key that never expires. `null` is
 *   a real answer ("never"), not missing data, and the table says so in words.
 * * `created_at` — ISO-8601.
 */
export interface ApiKeyRecord {
  key_id: string;
  owner_id: string;
  owner_email: string;
  roles: string[];
  /** ISO-8601, or `null` for a key that never expires. */
  expiration: string | null;
  /** ISO-8601. */
  created_at: string;
}

/**
 * THE ONE DTO THAT EVER CARRIES A SECRET (Story 36-6, ADR-028 §D7).
 *
 * It is an `ApiKeyRecord` plus one field, mirroring the server's own
 * `CreateApiKeyResponse(ApiKeyRecord)`. Both `POST /auth/apikeys` and
 * `POST /auth/apikeys/{key_id}/rotate` answer with this shape — which is why
 * ONE reveal component serves both flows rather than two that can drift.
 *
 * It lives here, beside `ApiKeyRecord`, because `ApiService` imports it and
 * `core -> page` is a forbidden ESLint edge. Same reasoning, same file.
 */
export interface CreateApiKeyResponse extends ApiKeyRecord {
  /**
   * The plaintext key. The server surfaces it EXACTLY ONCE, on create and on
   * rotate, and never again — it is not recoverable from any other route, by
   * the server or by this client.
   *
   * Render it, offer a copy control, then DROP it. It must never be written to
   * a service field, a subject, a component property that outlives the panel, a
   * URL, `localStorage` / `sessionStorage`, or a log line. Anything derived
   * from this DTO for storage goes through an explicit allowlist projection
   * (`toRecord`), never a spread or a rest-destructure — an unknown field on a
   * secret-bearing DTO must be dropped by default, not carried through.
   */
  plaintext_key: string;
}

/**
 * The create body — `POST /auth/apikeys` takes these as inlined `Body` fields.
 *
 * `owner_id` / `owner_email` are free-form on the server and the route is
 * admin-gated, so an admin may mint a key in another identity's name. The
 * dialog defaults them to the caller precisely so that stays a deliberate edit.
 *
 * `owner_email` may legitimately be `''`: a machine identity has none.
 */
export interface CreateApiKeyRequest {
  owner_id: string;
  owner_email: string;
  roles: string[];
  /** ISO-8601, or `null` / omitted for a key that never expires. */
  expiration?: string | null;
}
