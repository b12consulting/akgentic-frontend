import { Pipe, PipeTransform } from '@angular/core';

import { metadataEntries, TeamMetadataEntry } from './team.interface';

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
 */
@Pipe({ name: 'teamMetadata' })
export class TeamMetadataPipe implements PipeTransform {
  transform(metadata: Record<string, unknown> | null | undefined): TeamMetadataEntry[] {
    return metadataEntries(metadata);
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
