/**
 * Catalog data models — map to catalog-service DTOs.
 */

/**
 * Flat summary of a catalog namespace, returned by `GET /catalog/namespaces`.
 *
 * Maps to the catalog backend's `NamespaceSummary` DTO (catalog Story 16.6):
 * a purpose-built, picker-friendly shape — no `Entry` envelope, no payload,
 * no user/parent/model metadata.
 */
export interface NamespaceSummary {
  namespace: string;
  name: string;
  description: string;
}
