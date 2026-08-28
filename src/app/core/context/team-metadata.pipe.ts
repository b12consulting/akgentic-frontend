import { Pipe, PipeTransform } from '@angular/core';

import { metadataEntries, teamTitle, TeamMetadataEntry } from './team.interface';

/**
 * A team's metadata as render-ready pairs, memoised.
 *
 * THE MEMOISATION IS THE POINT, not a nicety. `metadataEntries` builds a fresh
 * array of fresh objects on every call, so calling it straight from a template
 * — `*ngFor="let entry of metadataEntries(team)"` — hands `NgForOf` a set of
 * brand-new identities on EVERY change-detection cycle. Its default differ
 * tracks by identity, so it concludes every item was replaced and rebuilds the
 * whole chip list each tick: the DOM nodes visibly churn in devtools and any
 * text selection or hover inside them is lost.
 *
 * A PURE pipe (the default) is Angular's own answer: `transform` runs only
 * when the input REFERENCE changes, and the framework caches the result, so
 * repeat cycles see the identical array and the differ finds nothing to do.
 *
 * Pure also means MUTATING a metadata object in place will not repaint. That
 * is correct here — `metadata` arrives from the server and is replaced
 * wholesale by the next fetch, never edited in place.
 *
 * Each embedded view gets its own pipe instance, so a table row memoises
 * independently of its neighbours.
 *
 * `titleKey` is the SECOND argument rather than a separate pipe because the
 * exclusion and the list are one decision: a surface that promotes the title
 * field to a heading must drop it here in the same breath, or the row shows it
 * twice. A pure pipe re-runs when ANY argument changes, so passing it costs
 * nothing while the namespace stays put — which is most of the time.
 */
@Pipe({ name: 'teamMetadata' })
export class TeamMetadataPipe implements PipeTransform {
  transform(
    metadata: Record<string, unknown> | null | undefined,
    titleKey?: string | null,
  ): TeamMetadataEntry[] {
    return metadataEntries(metadata, titleKey);
  }
}

/**
 * A team's title as one line of text, or `null` when it has none.
 *
 * A pipe rather than a component method for the same reason as above: a method
 * in a binding re-runs on every change-detection cycle. The consequence is
 * milder here — the result is a string, so nothing is torn down and rebuilt —
 * but the row template already uses `*ngIf … as` on this value, and re-running
 * the whole resolution per row per tick to produce a string that never changed
 * is work nobody asked for.
 *
 * Pure, and both inputs are references or primitives, so a row recomputes only
 * when its metadata object is replaced or the namespace's contract changes.
 */
@Pipe({ name: 'teamTitle' })
export class TeamTitlePipe implements PipeTransform {
  transform(
    metadata: Record<string, unknown> | null | undefined,
    titleKey: string | null | undefined,
  ): string | null {
    return teamTitle(metadata, titleKey);
  }
}

/**
 * `trackBy` for a metadata `*ngFor`, keyed on the metadata key.
 *
 * Belt to the pipe's braces. The pipe already stops the common case — an
 * unchanged reference produces no work at all — but a genuinely new metadata
 * object carrying the same keys does reach the differ, and identity tracking
 * would rebuild every chip to render the same text. Tracking the key rebinds
 * in place instead. The key is unique within one team's metadata (it is an
 * object key), which is exactly the scope of this list.
 */
export function trackMetadataEntry(_index: number, entry: TeamMetadataEntry): string {
  return entry.key;
}
