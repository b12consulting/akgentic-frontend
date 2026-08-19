/**
 * The admin area's navigable sections (Story 36-1).
 *
 * One typed descriptor per pane, so the rail, the route table and any future
 * section-aware surface agree on labels, icons and role requirements without
 * re-deriving them. `path` is the CHILD segment under `/admin` — the rail
 * composes `['/admin', path]`, keeping the segment written once.
 */
export interface AdminSection {
  /** Rail label. */
  readonly label: string;
  /** PrimeIcons class for the rail entry. */
  readonly icon: string;
  /** Child segment under `/admin` (e.g. `catalog` → `/admin/catalog`). */
  readonly path: string;
  /**
   * Whether the section is reachable only by an admin. This drives what the
   * rail OFFERS; `adminGuard` is what enforces it on the route, and the
   * server's role check is what actually protects the data.
   */
  readonly adminOnly: boolean;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { label: 'Catalog', icon: 'pi pi-list', path: 'catalog', adminOnly: false },
  { label: 'API Keys', icon: 'pi pi-key', path: 'api-keys', adminOnly: true },
];

/** The sections a caller with this role can actually reach. */
export function reachableSections(isAdmin: boolean): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => !section.adminOnly || isAdmin);
}
