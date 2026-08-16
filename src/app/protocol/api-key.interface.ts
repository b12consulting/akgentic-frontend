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
