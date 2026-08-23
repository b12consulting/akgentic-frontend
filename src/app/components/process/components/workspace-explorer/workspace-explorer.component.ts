import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
  ViewChild,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TreeModule } from 'primeng/tree';
import { TreeNode } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ScrollPanelModule } from 'primeng/scrollpanel';
import { TooltipModule } from 'primeng/tooltip';
import { CardModule } from 'primeng/card';
import { ToolbarModule } from 'primeng/toolbar';
import { DividerModule } from 'primeng/divider';
import { TagModule } from 'primeng/tag';
import { MarkdownModule } from 'ngx-markdown';
import { from, of, switchMap } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import {
  WorkspaceService,
  FileNode,
  FileContent,
} from '../../workspace/workspace.service';
import { ContextService } from '../../../../core/context/context.service';
import {
  WorkspaceInvalidation,
  WorkspaceInvalidationService,
} from '../../selectors/workspace-invalidation.selector';
import { UploadModalComponent } from './upload-modal/upload-modal.component';

/**
 * Outcome of one declarative root-tree load. `switchMap` maps each
 * `workspaceId` emission to a stream of these so the subscriber only ever
 * applies the LATEST load's result — a superseded slow response is cancelled
 * before it can clobber a newer tab's tree (ADR-021 §Decision 2, race closure).
 */
interface RootLoadResult {
  nodes: TreeNode[] | null;
  /**
   * The same load's RAW listing, carried beside `nodes` so the main pane's flat
   * list can be applied from the request the tree was going to make anyway.
   *
   * A separate `fetchTree('')` for the list would double every root load —
   * including the gesture-less ones — and move `getWorkspaceTree` call counts
   * on paths that have nothing to do with the list (ADR-033 §D2). It is the
   * raw `FileNode[]` rather than the converted `TreeNode[]` so the listing is
   * not reconstructed out of a shape built for PrimeNG.
   */
  entries: FileNode[] | null;
  error: string | null;
  /**
   * True when NO user gesture is behind the load that produced this result.
   *
   * It rides on the result rather than on a component field because the write
   * it governs happens in `applyRootLoad`, asynchronously and possibly after a
   * second load from a different origin has started — a shared "current mode"
   * field attributes the wrong origin to whichever load settles second.
   */
  background: boolean;
}

/**
 * First-seen-order union of two target lists — the same dedup rule
 * `WorkspaceInvalidationService` applies within a single instruction, applied
 * again ACROSS the instructions of one batch.
 */
function unionTargets(current: string[], next: string[]): string[] {
  return [...new Set([...current, ...next])];
}

@Component({
  selector: 'app-workspace-explorer',
  standalone: true,
  imports: [
    CommonModule,
    TreeModule,
    ButtonModule,
    ProgressSpinnerModule,
    ScrollPanelModule,
    TooltipModule,
    CardModule,
    ToolbarModule,
    DividerModule,
    TagModule,
    MarkdownModule,
    UploadModalComponent,
  ],
  templateUrl: './workspace-explorer.component.html',
  styleUrls: ['./workspace-explorer.component.scss'],
  // OnPush + signals: a signal write notifies the OnPush chain automatically,
  // so the explorer's subtree is no longer skipped when ApplicationRef.tick
  // walks past an OnPush ancestor that the child never marked dirty (ADR-021
  // §Decision 1 — this is what removes the multi-second spinner stall).
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceExplorerComponent {
  @ViewChild(UploadModalComponent) uploadModal!: UploadModalComponent;

  /**
   * Optional workspace addressed by this explorer (Epic 23 / ADR-019). A signal
   * input with an `undefined` default behaves byte-for-byte like the previous
   * optional `@Input`: unset ⇒ every WorkspaceService call omits `workspaceId`
   * so the backend falls back to `team_id`; set ⇒ it is threaded through every
   * call. A change re-triggers the root tree load via `toObservable → switchMap`
   * (ADR-021 §Decision 4 — contract preserved).
   */
  workspaceId = input<string | undefined>();

  workspaceService = inject(WorkspaceService);
  contextService = inject(ContextService);
  private destroyRef = inject(DestroyRef);

  /**
   * The unit that turns completed workspace tool calls into re-read
   * instructions (Epic 39 / ADR-031; Epic 42 / §D11). Component-scoped,
   * provided on `ProcessComponent` next to `WorkspaceRegistryService`: it reads
   * the team-scoped message log, so it shares that log's lifetime. It does NOT
   * fold that log — it subscribes to `appended$` and holds its in-flight calls
   * — but the scoping rule is unchanged, and a root-scoped instance would
   * outlive the team switch that empties its state.
   */
  private invalidations = inject(WorkspaceInvalidationService);

  processId: string = '';

  /**
   * Run state read LIVE off the stream ADR-010 makes its sole writer, so a
   * restore or a stop that happens without a page reload reaches the disabled
   * gate on the three upload controls immediately (the only controls this
   * component gates on run state). `toSignal` in a field initializer picks
   * up the ambient `DestroyRef` and unsubscribes on destroy; a signal read
   * notifies the OnPush chain, so no `markForCheck` bookkeeping is needed.
   * Must stay BELOW `contextService` — field initializers run top-to-bottom.
   */
  isProcessRunning = toSignal(this.contextService.currentTeamRunning$, {
    initialValue: false,
  });

  // Template-bound state as signals — signal writes notify the OnPush chain.
  treeNodes = signal<TreeNode[]>([]);

  /**
   * The navigator's selected node, held HERE rather than inside `p-tree`.
   *
   * PrimeNG keeps its own selection when `[selection]` is unbound, and nothing
   * outside the tree can clear it — so the `Root` row above the tree would
   * highlight while the previously chosen folder stayed highlighted too, two
   * rows claiming to be where the pane is. Owning the value is what lets the
   * root row deselect the tree.
   *
   * `null` means the root, which is the one location the tree has no node for.
   */
  selectedTreeNode = signal<TreeNode | null>(null);

  /**
   * Where the pane is, as a workspace-relative path. `''` IS the root — not
   * "nothing selected" (ADR-033 §D1, §D4).
   *
   * There is deliberately no nullable variant and no `initialised` flag. The
   * synthetic `Root Folder` wrapper node that used to stand for the root is
   * gone, so the root has no node to select and needs none: the list is simply
   * empty until the listing arrives, which is what `loading` is for.
   */
  currentDirectory = signal<string>('');

  /**
   * The file whose bytes the pane is showing, or `null` for the list view.
   *
   * Together with `currentDirectory` this pair is TOTAL: every state the pane
   * can be in is one directory plus zero-or-one open file, and "a file and a
   * folder are both selected" is unrepresentable because there is no second
   * field to write (ADR-033 §D1).
   */
  openFile = signal<FileNode | null>(null);

  /**
   * The loaded body and what kind of thing it is — one fact, one signal.
   *
   * Replaces `fileContent` + `isBinaryFile` + `isMarkdownFile`, which could
   * express `binary && markdown`: meaningless, representable, and defended
   * against by hand in three template conditions (ADR-033 §D5). `body` is a
   * `string`, so a text result whose `content` is `null` reads as `''` rather
   * than collapsing back into "no content loaded".
   */
  content = signal<{
    kind: 'text' | 'markdown' | 'binary';
    body: string;
  } | null>(null);

  /**
   * The directory listing the main pane renders, tagged with the path it
   * describes — or `null` before the first one arrives (ADR-033 §D2).
   *
   * **The path rides on the value** for the reason `content`'s kind does (§D5)
   * and the reason `applyFileContent` compares paths (ADR-030 §A4): a listing
   * and the directory it describes are ONE fact, and two fields let them
   * disagree. Every reader — the supersession rule in `applyListing`, the
   * "does this describe where I am?" test the template applies through
   * `listedEntries` — is that one comparison, which is also why no in-flight
   * flag is needed: a listing that does not name `currentDirectory()` is
   * exactly the set of "in flight" and "never fetched".
   */
  listing = signal<{ path: string; entries: FileNode[] } | null>(null);

  loading = signal(false);
  loadingContent = signal(false);

  /**
   * Failure of a TREE-scoped read — the root load and the lazy expand. Gates
   * the navigator's file tree and nothing else.
   *
   * Split from `fileError` (ADR-033 §D7) because one signal with five writers
   * gating both the tree and the pane is what made a single failed file read
   * blank the whole navigator — `backlog.md` rows 16, 19 and 21 in one cause.
   * Each half now has exactly one owner: a write site belongs to this one or to
   * that one, never to both.
   */
  treeError = signal<string | null>(null);

  /** Failure of a FILE-scoped read — the body read and the metadata refresh. Gates the pane only. */
  fileError = signal<string | null>(null);

  /**
   * Path of the open file that a workspace tool has just deleted, or `null`.
   * Drives its own `viewMode` value and its own block in the preview pane.
   *
   * It is deliberately NOT an error signal, and the error split does not absorb
   * it. A deletion is not a failed read: nothing went wrong, the pane simply has
   * nothing left to describe, and the notice has to name the file and invite the
   * next selection. Folding it into `fileError` would also make it compete with
   * a genuine read failure for one slot.
   */
  deletedNotice = signal<string | null>(null);

  /**
   * The single thing the pane is showing, computed once and switched on once
   * (ADR-033 §D6).
   *
   * The template used to test five signals across six mutually-exclusive
   * `*ngIf` blocks, two of which carried comments explaining that they would
   * otherwise render together and "read as two panes disagreeing". That class
   * of bug is structural here: the function is TOTAL — every reachable state
   * returns exactly one value — so two blocks cannot be simultaneously true.
   *
   * The order is the priority order and is load-bearing:
   *
   * 1. a read in flight outranks everything, including a stale failure;
   * 2. a deletion notice outranks the list view it would otherwise sit beside;
   * 3. a file failure with NO body to fall back on takes the pane. With a body
   *    on screen it does NOT — the banner renders above the switch and the body
   *    stays, because losing a readable document because a re-read failed is
   *    strictly worse than reading a slightly old one under a warning
   *    (ADR-030 §D5);
   * 4. no open file is the list view;
   * 5. otherwise the loaded body decides its own renderer.
   *
   * The fallthrough — an open file with no content and no error — is reachable
   * only between `openFile` being set and the first read settling, a window in
   * which `loadingContent` is already true on the selection path. It returns
   * `'loading'` so the total-ness holds without a seventh state.
   */
  viewMode = computed<
    'loading' | 'error' | 'deleted' | 'list' | 'text' | 'markdown' | 'binary'
  >(() => {
    if (this.loadingContent()) return 'loading';
    if (this.deletedNotice() !== null) return 'deleted';
    const loaded = this.content();
    if (this.fileError() !== null && loaded === null) return 'error';
    if (this.openFile() === null) return 'list';
    return loaded?.kind ?? 'loading';
  });

  /**
   * The toolbar trail: **Root** first, then one crumb per path segment.
   *
   * Always at least one entry, so the toolbar has something to render at the
   * root instead of a placeholder — the root IS a location, and naming it is
   * more useful than *"Select a file or folder"*.
   *
   * Each crumb carries the absolute path to navigate to, accumulated left to
   * right, so a click never has to re-derive it from an index. `last` marks the
   * current directory, which renders as text rather than a link: it is where
   * the pane already is.
   *
   * Derived from `currentDirectory()` alone, deliberately. It does not consult
   * `openFile()`, so opening a file leaves the trail describing that file's
   * directory — which after §D3's file-open rule is exactly where the pane is.
   */
  breadcrumb = computed<{ name: string; path: string; last: boolean }[]>(() => {
    const segments = this.currentDirectory().split('/').filter(Boolean);
    const crumbs = [{ name: 'Root', path: '', last: segments.length === 0 }];
    let path = '';
    segments.forEach((segment, index) => {
      path = path === '' ? segment : `${path}/${segment}`;
      crumbs.push({
        name: segment,
        path,
        last: index === segments.length - 1,
      });
    });
    return crumbs;
  });

  /**
   * The rows the list renders — folders first — or `null` while `listing()`
   * does not describe `currentDirectory()`.
   *
   * `null` is the render-nothing case, and it covers BOTH "a listing is in
   * flight" and "none was ever fetched" with one comparison. That is what stops
   * *"this folder is empty"* flashing on every navigation without a
   * `listingLoading` signal to go stale: an empty array here means the backend
   * said the directory is empty, and `null` means we do not know yet.
   *
   * Directories first, then files, each block sorted by name. The backend's own
   * order is deliberately **not** preserved: it is whatever the filesystem
   * yielded, which is stable enough to look intentional and arbitrary enough to
   * be unfindable. Two predictable blocks beat one unpredictable one.
   *
   * `localeCompare` with `sensitivity: 'base'` so `Reports` and `reports` sort
   * as neighbours rather than by code point, which would put every capitalised
   * name in a block of its own above the lowercase ones. `numeric` so `file10`
   * follows `file9` instead of `file1`.
   */
  listedEntries = computed<FileNode[] | null>(() => {
    const listed = this.listing();
    if (listed === null || listed.path !== this.currentDirectory()) return null;
    const byName = (a: FileNode, b: FileNode): number =>
      a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    return [
      ...listed.entries.filter((entry) => entry.type === 'directory').sort(byName),
      ...listed.entries.filter((entry) => entry.type !== 'directory').sort(byName),
    ];
  });

  /**
   * True while a per-file refresh is in flight — the ONLY state this feature
   * adds. It drives the toolbar control's disabled binding AND the guard at the
   * top of `refreshSelectedFile`, so a second activation cannot race the first
   * (ADR-030 §D3) whichever entry point it arrives through. It is deliberately
   * not a cache, a "last refreshed at" stamp, or a dirty flag: the panel keeps
   * holding exactly one file's bytes, read on demand.
   */
  refreshingFile = signal(false);

  /**
   * Monotonic id stamped on every body read so a response can be matched back to
   * the request that issued it. `readToken` is the id of the most recently
   * ISSUED read; `loadingOwner` is the id of the read that raised the spinner.
   *
   * Nothing else correlates the two: `loadFileContent` is a bare `await`, and
   * `onNodeSelect` issues a read without awaiting or cancelling one already in
   * flight, so select A then B and A's late response still wins every write it
   * is allowed to make. These two counters are what make "superseded" a thing
   * the method can ask about — see `applyFileContent` for the pane's own,
   * stricter, path-based rule.
   */
  private readToken = 0;
  private loadingOwner = 0;

  /**
   * The union of every instruction accepted since the last flush, or `null`
   * when no batch is pending — which doubles as "no flush is scheduled".
   *
   * `LogFeeder` batches frames at 16 ms, so ten `workspace_write` returns
   * arrive in ONE append — and `WorkspaceInvalidationService` pushes out every
   * instruction that append completes SYNCHRONOUSLY, in log order, one per
   * completed call. Routing each as it arrives would issue ten listings of the
   * same directory (NFR4). Directory granularity dedupes only WITHIN one
   * `workspace_multi_edit`; the coalescing across separate calls is this
   * component's.
   */
  private pendingBatch: WorkspaceInvalidation | null = null;

  // Plain fields: not template-bound through *ngIf/[value] in a way that the
  // OnPush stall affects (sidebar/upload-modal toggles are driven by user
  // events that already mark the view), so they stay as ordinary fields.
  sidebarVisible = false; // Start collapsed
  uploadModalVisible = false;
  uploadTargetPath: string = '';

  constructor() {
    // Resolve processId synchronously from the BehaviorSubject so it is
    // available at the root stream's first emission (resolving it from an
    // awaited init hook would race the toObservable(workspaceId) first tick).
    this.processId = this.contextService.currentProcessId$.value;

    // Declarative root-tree load: every workspaceId emission (incl. the initial
    // `undefined`) maps to a fresh fetch; switchMap cancels the in-flight
    // previous load so a superseded slow response cannot overwrite a newer
    // tab's treeNodes (ADR-021 §Decision 2). Stable APIs only — no resource().
    toObservable(this.workspaceId)
      .pipe(
        switchMap((ws) => this.loadRootTree$(ws)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        this.applyRootLoad(result);
        this.applyRootListing(result);
      });

    // The panel stops being the one view that ignores the log it already
    // receives (Epic 39 / ADR-031): every completed mutating workspace tool
    // call becomes a re-read here. `takeUntilDestroyed` in the constructor's
    // injection context, the same shape the root-tree stream above uses.
    this.invalidations.invalidations$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((instruction) => this.acceptInvalidation(instruction));
  }

  /**
   * The workspace this explorer addresses, resolved AT INSTRUCTION TIME.
   *
   * `workspaceId` is an OPTIONAL input (ADR-019): unset means the team default
   * tab. The registry keys the default descriptor on `msg.team_id`, so an
   * instruction for it carries the team id — which is exactly what `processId`
   * holds, and what every `WorkspaceService` call already passes first. Hence
   * the fallback. Comparing `instruction.workspaceId` against the raw input
   * instead is `undefined === 'team-1'` on the default tab, and silently drops
   * every instruction it should act on.
   *
   * Never captured at construction: signal inputs are populated AFTER the
   * constructor runs, so a captured value is `undefined` for every named tab —
   * which would then match the DEFAULT workspace's instructions instead of its
   * own. An unresolved context leaves `processId` at `''`, which no well-formed
   * instruction carries, so nothing routes until it resolves; that is intended,
   * and no retry or queue is added for it.
   */
  private addressedWorkspace(): string {
    return this.workspaceId() ?? this.processId;
  }

  /**
   * Filter one instruction by workspace, fold it into the pending batch, and
   * schedule the flush.
   *
   * A microtask is exact here rather than merely cheap: the invalidation unit
   * emits one append's whole burst synchronously, so the microtask that follows
   * it sees every instruction of that burst and adds no observable latency.
   * That synchronicity is a DEPENDENCY, not an observation — an asynchronous
   * scheduler over there turns one coalesced listing per directory back into
   * one listing per event with every spec here still green — and it is pinned
   * on that side by `(AC26)`. A `setTimeout` / `bufferTime` debounce would work
   * too but reintroduces a timer, and "nothing polls in this panel" is a
   * property worth keeping literally true.
   */
  private acceptInvalidation(instruction: WorkspaceInvalidation): void {
    if (instruction.workspaceId !== this.addressedWorkspace()) return;

    const alreadyScheduled = this.pendingBatch !== null;
    this.pendingBatch = this.mergeInvalidation(this.pendingBatch, instruction);
    if (!alreadyScheduled) {
      queueMicrotask(() => this.flushInvalidations());
    }
  }

  /**
   * Union one instruction into the pending batch: `wholeTree` is a logical OR,
   * the three target lists are first-seen-order unions. Fresh arrays every
   * time — the incoming instruction's own arrays are never mutated, because one
   * agent mutation mapping to two workspaces yields two instructions that must
   * stay independent.
   */
  private mergeInvalidation(
    batch: WorkspaceInvalidation | null,
    next: WorkspaceInvalidation,
  ): WorkspaceInvalidation {
    if (batch === null) {
      return {
        workspaceId: next.workspaceId,
        wholeTree: next.wholeTree,
        directories: [...next.directories],
        files: [...next.files],
        deletions: [...next.deletions],
      };
    }
    return {
      workspaceId: batch.workspaceId,
      wholeTree: batch.wholeTree || next.wholeTree,
      directories: unionTargets(batch.directories, next.directories),
      files: unionTargets(batch.files, next.files),
      deletions: unionTargets(batch.deletions, next.deletions),
    };
  }

  /** Consume the pending batch (clearing the "flush scheduled" state) and route it. */
  private flushInvalidations(): void {
    const batch = this.pendingBatch;
    this.pendingBatch = null;
    if (batch === null) return;
    this.routeInvalidation(batch);
  }

  /**
   * Turn one coalesced batch into re-reads, through the paths that already
   * exist — `refresh()`, `refreshSelectedFile()`, `refreshDirectory()`. No new
   * fetch path, no cache, no second splice.
   *
   * A whole-tree instruction subsumes every named target and carries all three
   * lists empty by construction, so it returns early rather than reconciling
   * anything.
   *
   * The open file's parent is dropped from the directory pass whenever the
   * open-file refresh runs: `refreshSelectedFile` → `refreshFileMetadata` →
   * `refreshDirectory(parent)` already re-lists it, and a `workspace_edit` on
   * the open file names both, so routing both naively lists the directory
   * twice. It is dropped ONLY when that refresh will actually run — the
   * in-flight guard can decline it, and dropping the parent for a refresh that
   * never happens loses the listing as well as the re-read.
   */
  private routeInvalidation(batch: WorkspaceInvalidation): void {
    // The two gesture-less call sites of the whole component. Everything they
    // reach — the root load, the body read, the metadata listing — logs its
    // failure instead of bannering it, because nobody asked for these reads
    // (ADR-031 §D9). The error split narrows the blast radius of getting that
    // wrong; it does not remove the rule.
    if (batch.wholeTree) {
      this.refresh(true);
      return;
    }

    const directories = new Set(batch.directories);
    const open = this.openFile();
    if (open !== null && batch.deletions.includes(open.path)) {
      // Deletion wins over a change to the same path within one batch: a
      // delete-then-recreate inside a single 16 ms batch settles as "deleted",
      // and the next batch — or either Refresh control — recovers it.
      this.discardDeletedFile(open);
    } else if (
      open !== null &&
      batch.files.includes(open.path) &&
      this.canRefreshSelectedFile()
    ) {
      directories.delete(this.getParentPath(open.path));
      void this.refreshSelectedFile(true);
    }

    for (const path of directories) {
      // A background listing that fails must not banner: no user gesture is
      // behind this fetch. The manual Refresh controls remain the loud path.
      void this.refreshDirectory(path).catch((error: unknown) => {
        console.error('Error refreshing directory', error);
      });
    }
  }

  /**
   * Whether a per-file refresh would run right now, rather than be declined by
   * the in-flight guard (ADR-030 §D3).
   *
   * One predicate, two readers, on purpose. `refreshSelectedFile` asks it to
   * enforce the gate; the invalidation routing asks it BEFORE dropping the open
   * file's parent from the directory pass, because that exclusion is only
   * correct if the refresh it defers to actually happens. A declined refresh
   * with the parent already dropped issues nothing at all for a batch that
   * named both — the tree entry then stays stale with nothing scheduled to
   * correct it. Falling through to the directory pass instead re-lists the
   * parent; the body the in-flight read is about to deliver may still be
   * pre-mutation, and the next batch or either Refresh control recovers it.
   */
  private canRefreshSelectedFile(): boolean {
    return !this.refreshingFile() && !this.loadingContent();
  }

  /**
   * The open file has been deleted under the pane. Clear the pane AND the
   * selection, and raise the notice naming it.
   *
   * No read is issued for the path — `deletions` is a separate field from
   * `files` exactly because re-reading a deleted path 404s. Leaving the pane
   * rendering a file that no longer exists is the other half of the same
   * refusal.
   *
   * `currentDirectory` is deliberately NOT written: the file is gone, the
   * directory the user was in is not, and moving them somewhere else on a
   * deletion they did not perform is the same "an agent navigated me" surprise
   * `applyRootLoad` refuses.
   *
   * The tree entry goes with it: the instruction carries the file's parent in
   * `directories`, and the directory pass re-lists it in this same batch.
   */
  private discardDeletedFile(file: FileNode): void {
    this.openFile.set(null);
    this.content.set(null);
    this.deletedNotice.set(file.path);
  }

  /**
   * Map one `workspaceId` value to a root-load stream that resolves to the
   * root's ENTRIES on success and maps a rejection to an error message.
   * Returns an empty (no-op) load when `processId` is not yet resolved.
   *
   * The spinner is raised ONLY for a load a user asked for. The navigator's
   * tree is gated on `!loading()`, so raising it for a gesture-less load
   * unmounts the whole file tree for a round trip every time an agent writes a
   * file — `backlog.md` row 24, and the other half of the rule ADR-031 §D9
   * already applies to the banner (ADR-033 §D9). Its release is conditional on
   * the same flag, so a background load can neither raise nor lower a spinner a
   * gesture load is holding.
   */
  private loadRootTree$(ws?: string, background: boolean = false) {
    if (!this.processId) {
      return of<RootLoadResult>({
        nodes: null,
        entries: null,
        error: null,
        background,
      });
    }

    if (!background) {
      this.loading.set(true);
      // Clearing the banner is as tree-scoped a write as setting it: the
      // navigator is gated on `!treeError()`, so erasing a genuine root-load
      // failure from a read the user never asked for makes the tree reappear
      // rendering whatever `treeNodes` still holds, with the failure silently
      // gone (ADR-031 §D9).
      this.treeError.set(null);
    }

    return from(this.fetchTree('', ws)).pipe(
      map((tree): RootLoadResult => ({
        nodes: this.convertToTreeNodes(tree),
        entries: tree,
        error: null,
        background,
      })),
      catchError((error: any) => {
        console.error('Error loading workspace', error);
        return of<RootLoadResult>({
          nodes: null,
          entries: null,
          error: error?.message || 'Failed to load workspace',
          background,
        });
      }),
      tap(() => {
        if (!background) this.loading.set(false);
      }),
    );
  }

  /**
   * Apply the latest (switchMap-guarded) root-load result to the signals.
   *
   * This is the sink for the declarative root stream AND for `refresh(background)`,
   * and it may write `treeNodes` and `treeError` and NOTHING else. It must never
   * write `currentDirectory` or `openFile`: an agent writing a file would then
   * navigate the user back to the root mid-read, and a superseded slow load would
   * be able to move them too (ADR-033 §NFR1).
   */
  private applyRootLoad(result: RootLoadResult): void {
    if (result.error !== null) {
      if (result.background) {
        // A read with no user gesture behind it is logged, never bannered
        // (ADR-031 §D9). `treeError` gates the navigator's whole file tree, so
        // bannering a load the event stream issued blanks the panel with
        // nothing behind it — and the open file survives, so the manual
        // Refresh re-enters the identical failure and the panel stays stuck.
        console.error('Background workspace load failed', result.error);
        return;
      }
      this.treeError.set(result.error);
      return;
    }
    if (result.nodes !== null) {
      this.treeNodes.set(result.nodes);
    }
  }

  /**
   * Apply the SAME root-load result to the main pane's list — but only while
   * the pane is actually at the root.
   *
   * Deliberately a second method rather than three lines inside
   * `applyRootLoad`, and the separation is the whole design (ADR-033 §D2):
   * `applyRootLoad` writes `treeNodes` and `treeError` and nothing else, so a
   * background refresh can never move the user, and after this it must not
   * repaint their directory either. A user sitting in `docs/deep` while an
   * agent writes a file gets a fresh TREE and an untouched LIST — the
   * `currentDirectory() === ''` guard is what makes that true, and it is the
   * only thing standing between a gesture-less load and the root's entries
   * appearing under a subdirectory's name.
   *
   * Reading the load's own result is also what keeps the root free: the tree
   * fetch and the list fetch ARE the same `fetchTree('')`, so nothing here
   * issues a request and no `getWorkspaceTree` call count moves.
   */
  private applyRootListing(result: RootLoadResult): void {
    if (result.error !== null || result.entries === null) return;
    if (this.currentDirectory() !== '') return;
    this.listing.set({ path: '', entries: result.entries });
  }

  /**
   * Fetch the listing for one directory and hand it to `applyListing`.
   *
   * The failure is logged rather than bannered. A `fileError` here would take
   * the whole pane (`viewMode` returns `'error'` with no content loaded), so a
   * transient listing failure would replace the list — and the navigation that
   * issued it — with a banner the user cannot navigate out of. Recorded as an
   * open question in story 45-2 rather than decided here.
   */
  private async loadListing(path: string): Promise<void> {
    try {
      this.applyListing(path, await this.fetchTree(path));
    } catch (error: unknown) {
      console.error('Error listing directory', error);
    }
  }

  /**
   * Write one listing result into the pane — but ONLY while it still describes
   * where the pane is.
   *
   * `requestedPath` is the path the listing was ISSUED for; `currentDirectory()`
   * is read at RESOLUTION time. This is `applyFileContent`'s rule applied to
   * the list, for the identical reason (ADR-030 §A4): navigate A → B and A's
   * slow listing would otherwise render A's entries under B's name. It is the
   * fifth member of that family of guards and is written to the same shape.
   */
  private applyListing(requestedPath: string, entries: FileNode[]): void {
    if (requestedPath !== this.currentDirectory()) return;
    this.listing.set({ path: requestedPath, entries });
  }

  /**
   * Fetch a directory listing, threading `workspaceId` only when set so the
   * unset path keeps today's 2-arg call shape (and byte-identical URL). The
   * id is passed explicitly (rather than read off the signal) so the root load
   * uses the value that drove the current switchMap emission.
   */
  private fetchTree(path: string, ws: string | undefined = this.workspaceId()): Promise<FileNode[]> {
    return ws
      ? this.workspaceService.getWorkspaceTree(this.processId, path, ws)
      : this.workspaceService.getWorkspaceTree(this.processId, path);
  }

  convertToTreeNodes(nodes: FileNode[]): TreeNode[] {
    return nodes.map((node) => ({
      label: node.name,
      data: node,
      icon: this.getFileIcon(node),
      children: node.children
        ? this.convertToTreeNodes(node.children)
        : undefined,
      leaf: node.type === 'file',
      expanded: false,
    }));
  }

  getFileIcon(node: FileNode): string {
    if (node.type === 'directory') {
      return 'pi pi-folder';
    }

    const ext = node.extension?.toLowerCase() || '';
    const iconMap: { [key: string]: string } = {
      '.py': 'pi pi-file',
      '.ts': 'pi pi-file',
      '.js': 'pi pi-file',
      '.html': 'pi pi-file',
      '.css': 'pi pi-file',
      '.scss': 'pi pi-file',
      '.json': 'pi pi-file',
      '.md': 'pi pi-file',
      '.txt': 'pi pi-file',
      '.yml': 'pi pi-file',
      '.yaml': 'pi pi-file',
      '.xml': 'pi pi-file',
      '.sql': 'pi pi-file',
      '.sh': 'pi pi-file',
      '.java': 'pi pi-file',
      '.cpp': 'pi pi-file',
      '.c': 'pi pi-file',
      '.h': 'pi pi-file',
      '.go': 'pi pi-file',
      '.rs': 'pi pi-file',
      '.php': 'pi pi-file',
      '.rb': 'pi pi-file',
    };

    return iconMap[ext] || 'pi pi-file';
  }

  /**
   * PrimeNG lazy-expand handler: when a user clicks the expand arrow on a
   * directory TreeNode whose children have never been fetched (`children ===
   * undefined`), fetch that directory's entries from `WorkspaceService` and
   * splice them into the node. Loaded-empty (`children === []`) and loaded-
   * populated directories short-circuit via the `!== undefined` guard — the
   * second expand on any directory never issues a second HTTP call.
   */
  async onNodeExpand(event: {
    node: TreeNode;
    originalEvent?: Event;
  }): Promise<void> {
    const node = event.node;
    const fileNode = node.data as FileNode | undefined;

    // Only directories are lazy-loaded
    if (!fileNode || fileNode.type !== 'directory') return;
    // Cache hit: already loaded (empty or populated)
    if (node.children !== undefined) return;

    try {
      const children = await this.fetchTree(fileNode.path);
      node.children = this.convertToTreeNodes(children);
      // Re-assign the top-level array reference so the bound treeNodes signal
      // picks up the mutation on a nested TreeNode's `children` property.
      this.treeNodes.set([...this.treeNodes()]);
    } catch (error: any) {
      console.error('Error loading subdirectory', error);
      this.treeError.set(error?.message || 'Failed to load subdirectory');
      // Leave node.children as undefined so a subsequent user-initiated
      // expand can retry the fetch.
    }
  }

  /**
   * The NAVIGATOR's doorway into the two verbs. The list's row click is the
   * other one (`onEntryClick`), and both go through the same two methods.
   *
   * §D3 says why they must not each carry their own copy of the rule:
   * "otherwise the panel and the pane can point at different places — the same
   * disagreement the first draft's shared selection model existed to prevent,
   * merely relocated."
   *
   * The question story 45-1 recorded rather than guessed — does opening a file
   * from the TREE also descend to its parent? — is decided: **yes**, in
   * `openFileNode`, by ADR-033 §D3 as amended. With no list and no Back control
   * 45-1 had nothing to be consistent with; now "Back stays put" and "Back from
   * a nested file lands in that file's directory" are the same sentence only if
   * opening the file moved you there.
   */
  async onNodeSelect(event: any) {
    const node: FileNode = event.node.data;

    if (node.type === 'file') {
      await this.openFileNode(node);
    } else if (node.type === 'directory') {
      this.navigateTo(node.path);
    }
  }

  /** The LIST's doorway into the same two verbs (ADR-033 §D3). */
  onEntryClick(entry: FileNode): void {
    if (entry.type === 'directory') {
      this.navigateTo(entry.path);
      return;
    }
    void this.openFileNode(entry);
  }

  /**
   * Descend into (or ascend to) a directory: the pane moves, whatever file was
   * open closes, and the listing for the new directory is fetched.
   *
   * `fileError` is cleared with `content` and not merely alongside it. Without
   * that clear the pane returns `viewMode === 'error'` — a file failure with no
   * content — and the navigation appears to do nothing: the file-scoped banner
   * has nothing left to describe once its file is closed. This NARROWS
   * `backlog.md` row 33(a) (a gesture now clears the banner) and does not close
   * it: neither `fileError` write site has acquired a path rule.
   *
   * `deletedNotice` goes for the same reason — the notice describes a file the
   * pane is no longer about.
   */
  private navigateTo(path: string): void {
    this.currentDirectory.set(path);
    this.openFile.set(null);
    this.content.set(null);
    this.fileError.set(null);
    this.deletedNotice.set(null);
    this.syncTreeSelection(path);
    void this.loadListing(path);
  }

  /**
   * Point the navigator at *path*, whichever route the pane took to get there.
   *
   * Without this the tree's highlight followed clicks INSIDE the tree only, so
   * navigating by a breadcrumb crumb or a list row left the navigator
   * highlighting a folder the pane had left — and the ``Root`` row, whose whole
   * job is to answer "am I at the root", answered wrongly in both directions:
   * lit while the pane sat inside a folder reached from the list, unlit while
   * the pane was at the root after ascending out of the tree.
   *
   * ``null`` for the root, which has no node of its own, and equally for a path
   * whose node is not materialized — an unexpanded branch. Highlighting nothing
   * is the honest answer there; the alternative would light ``Root`` for a
   * directory that is not the root.
   */
  private syncTreeSelection(path: string): void {
    this.selectedTreeNode.set(
      path === '' ? null : this.findTreeNodeByPath(this.treeNodes(), path),
    );
  }

  /**
   * Open a file in the pane, from either view — and move the pane INTO that
   * file's directory (ADR-033 §D3, amended 2026-08-23).
   *
   * No listing is fetched here: the pane is showing the file, not the list.
   * `closeFile` is what pays for the listing, and only when the entries do not
   * already describe that directory. Pre-fetching would spend a request on a
   * view the user may never return to — accepted as designed, not an oversight.
   */
  private async openFileNode(node: FileNode): Promise<void> {
    this.deletedNotice.set(null);
    this.openFile.set(node);
    this.currentDirectory.set(this.getParentPath(node.path));
    await this.loadFileContent(node.path);
  }

  /**
   * **Root row** — the navigator's way back to the top.
   *
   * Clears the tree's selection as well as navigating, because the root is the
   * one location no tree node stands for: leaving the previous node selected
   * would show two highlighted rows, one of them wrong.
   */
  selectRoot(): void {
    this.selectedTreeNode.set(null);
    this.navigateToCrumb('');
  }

  /**
   * **Breadcrumb** — jump straight to an ancestor, from the toolbar trail.
   *
   * Ascending to an ancestor routes through `navigateTo`, so a crumb clears the
   * open file, its content and both notices exactly as every other navigation
   * does — a crumb that only moved the directory would leave the pane showing a
   * file from somewhere else.
   *
   * The crumb naming the pane's OWN directory is the exception, and it is what
   * the retired **Back** button was: with a file open it closes the file and
   * stays put, which `closeFile` does without re-listing entries that already
   * describe the directory. Routing it through `navigateTo` instead would spend
   * a request arriving where the pane already is.
   *
   * @param path Absolute workspace path of the crumb; `''` is the root.
   */
  navigateToCrumb(path: string): void {
    if (path !== this.currentDirectory()) {
      this.navigateTo(path);
      return;
    }
    if (this.openFile() !== null) this.closeFile();
  }

  /**
   * **Back** — close the file and STAY PUT. `currentDirectory` is untouched,
   * which is the whole distinction from Up (ADR-033 §D3).
   *
   * The re-fetch is conditional: coming back from a file opened in the
   * directory the pane is already in costs no request, because the entries
   * already describe it. After §D3's file-open rule that is the common case.
   */
  closeFile(): void {
    this.openFile.set(null);
    this.content.set(null);
    this.fileError.set(null);

    const here = this.currentDirectory();
    if (this.listing()?.path !== here) {
      void this.loadListing(here);
    }
  }

  /**
   * Read a file's body into the pane. ONE loader, two entry conditions:
   *
   * - **selection** (`refresh === false`, the default): the pane is showing a
   *   different file — or nothing — so it blanks, raises the spinner and
   *   repaints from scratch. Byte-for-byte the behaviour that shipped before
   *   the refresh control existed.
   * - **refresh** (`refresh === true`): the pane is already showing THIS file,
   *   so it is left rendered while the new bytes are fetched. `content` is
   *   never nulled and `loadingContent` is never raised — that, and nothing
   *   else, is what preserves the reader's scroll position (ADR-030 §D2). The
   *   kind is written from the RESULT rather than reset up front, because
   *   resetting it mid-flight flips the rendered block and flickers the pane.
   *
   * Orthogonal to both is `background`: was there a USER behind this read?
   * `refresh === true` cannot answer that — the toolbar *Refresh this file*,
   * the navigator *Refresh workspace* and the invalidation route all reach this
   * loader with it set, and the first two must keep reporting their failures.
   * On the gesture path `fileError` is cleared on entry (so a refresh that
   * succeeds after a failure clears the stale banner) and written on failure.
   * On the gesture-LESS path neither happens: nobody asked for the read, so it
   * neither raises a banner nor erases one that a gesture put there
   * (ADR-031 §D9). The failure is logged instead.
   *
   * Both writes are to `fileError`, never `treeError`: a body read is
   * file-scoped and after ADR-033 §D7 it cannot reach the navigator's gating at
   * all. That is the property that closes `backlog.md` rows 16, 19 and 21.
   *
   * A read that a NEWER read has already superseded writes nothing on the way
   * out either: not the body (see `applyFileContent`), not the error banner and
   * not the spinner. All three are the same race, and all three become routine
   * rather than rare once reads start firing from the event stream with no user
   * gesture behind them. Supersession and gesture are different questions and
   * both are asked: an event-driven re-read is typically the ONLY read in
   * flight, so the supersession test passes and would write the banner anyway.
   */
  async loadFileContent(
    path: string,
    refresh: boolean = false,
    background: boolean = false,
  ) {
    const token = ++this.readToken;
    if (!refresh) {
      this.loadingOwner = token;
      this.loadingContent.set(true);
      this.content.set(null);
    }
    if (!background) {
      this.fileError.set(null);
    }

    try {
      const result: FileContent = await this.workspaceService.getFileContent(
        this.processId,
        path,
        this.workspaceId()
      );
      this.applyFileContent(result, path);
    } catch (error: any) {
      console.error('Error loading file content', error);
      // Two independent reasons not to banner, and neither implies the other.
      // A superseded read's failure must not banner over a file the user is
      // now reading successfully. Supersession — not the pane's path rule — is
      // that test, because a read issued against no open file at all is still
      // this banner's to set. A gesture-less read must not banner either,
      // superseded or not: nobody asked for it.
      if (!background && token === this.readToken) {
        this.fileError.set(error?.message || 'Failed to load file content');
      }
    } finally {
      // Only the read that raised the spinner may lower it: a superseded read
      // clearing it strands a blank pane with no spinner while the newer read
      // is still fetching. Selecting a DIRECTORY issues no read, so it never
      // takes ownership and the in-flight read still releases the spinner it
      // raised — the reason this is an ownership test and not a path test.
      if (this.loadingOwner === token) {
        this.loadingContent.set(false);
      }
    }
  }

  /**
   * Write one `getFileContent` result into the pane's signals — but ONLY while
   * the result still belongs to the file the pane is showing.
   *
   * `requestedPath` is the path the read was ISSUED for; `openFile()` is read
   * at RESOLUTION time. They differ exactly when the response has been
   * superseded, and then NOTHING is written. Otherwise a slow read of file A
   * that loses the race still wins the write, and the pane renders A's bytes
   * under B's name and size tag — chrome disagreeing with the pane it labels,
   * which reads as authoritative because it looks deliberate (ADR-030 §A4).
   *
   * The tree closed this same race declaratively: its load is
   * `toObservable(workspaceId) → switchMap`, and `switchMap` drops a superseded
   * response before it can be applied (ADR-021 §Decision 2). The body read never
   * received the equivalent. This is that equivalent, written as a path
   * comparison rather than an operator because the read is a bare `await` inside
   * an `async` method.
   *
   * Two details that are easy to get wrong:
   *
   * - **No open file means no application.** With `openFile()` null there is
   *   no pane to write into — including the case where the user selected a
   *   *directory* while a file read was in flight. Both production entry points
   *   establish or require `openFile` before issuing a read, so a read with no
   *   open file is reachable only by driving this loader directly.
   * - **Compare paths, never `FileNode` identity.** A refresh replaces
   *   `openFile` with a fresh instance carrying the same path; an identity
   *   comparison would discard every refresh result.
   *
   * One `set` per outcome: the kind and the body land together, so there is no
   * instant at which the pane holds one file's bytes under another's renderer.
   * A text result whose `content` is `null` becomes `''` — the file is loaded
   * and empty, which is a different fact from "nothing is loaded" and must not
   * collapse back into it.
   */
  private applyFileContent(result: FileContent, requestedPath: string): void {
    if (requestedPath !== this.openFile()?.path) return;

    if (result.type === 'binary') {
      this.content.set({
        kind: 'binary',
        body: result.message || 'Binary file cannot be displayed',
      });
      return;
    }
    this.content.set({
      kind: this.isMarkdownPath(requestedPath) ? 'markdown' : 'text',
      body: result.content ?? '',
    });
  }

  /**
   * Markdown-ness of the path a read was issued for. The renderer has to follow
   * the bytes it is rendering, so this is decided by the request rather than by
   * whatever `openFile()` holds when the response lands — and by the path
   * rather than by `FileNode.extension`, which the listing may omit.
   */
  private isMarkdownPath(path: string): boolean {
    return path.toLowerCase().endsWith('.md');
  }

  /**
   * Re-read the open file: its body AND the metadata the chrome renders. Both
   * halves run on every activation — a refreshed body under a stale size tag is
   * worse than the staleness it fixes (ADR-030 §A4), so neither half returning
   * early is acceptable.
   *
   * The body is read FIRST so its `fileError` reset cannot wipe a listing
   * failure reported by the metadata half — both halves are file-scoped, so
   * they still share one signal and the ordering still matters.
   *
   * `background` travels to BOTH halves. It defaults to the gesture value, so
   * the two template call sites — which invoke this with no argument — keep
   * reporting their failures, and a caller that forgets the parameter fails
   * towards *an error is shown* rather than towards *an error disappears*.
   */
  async refreshSelectedFile(background: boolean = false): Promise<void> {
    const file = this.openFile();
    if (!file) return;

    // Enforce in code the gate the toolbar control applies in the template: the
    // workspace-scoped refresh reaches this method too and its button is NOT
    // bound to these signals. Two reads of the same file settle in arbitrary
    // order, so the loser repaints the pane with the OLDER bytes, and the first
    // `finally` would release the button while the second read is still live.
    if (!this.canRefreshSelectedFile()) return;

    this.refreshingFile.set(true);
    try {
      await this.loadFileContent(file.path, true, background);
      await this.refreshFileMetadata(file, background);
    } finally {
      this.refreshingFile.set(false);
    }
  }

  /**
   * Re-fetch the open file's parent listing through the existing
   * `refreshDirectory` (which already splices fresh children into the
   * materialized tree and tolerates a target that was never expanded), then
   * re-resolve the open file's own entry by path. A path absent from the fresh
   * listing leaves `openFile` as it is — the failed body read is what tells the
   * user the file has gone. A rejection here is reported and swallowed so it
   * cannot cancel the other half.
   *
   * The write is gated on the pane still showing the file this refresh was
   * issued for: the listing can land after the user has moved on, and writing
   * the re-resolved entry then puts THIS file's name and size tag above another
   * file's body — the same mismatch the body half guards against, arriving
   * through the other half of the refresh. The comparison is by PATH, never by
   * `FileNode` identity: `refreshDirectory` re-converts the listing into new
   * `TreeNode`s, so re-selecting the very same file mid-cycle hands
   * `onNodeSelect` a fresh `FileNode` instance for an unchanged path, and an
   * identity test would discard the metadata that selection still wants.
   */
  private async refreshFileMetadata(
    file: FileNode,
    background: boolean = false,
  ): Promise<void> {
    try {
      const fresh = await this.refreshDirectory(this.getParentPath(file.path));
      const entry = fresh.find((node) => node.path === file.path);
      if (entry && this.openFile()?.path === file.path) {
        this.openFile.set(entry);
      }
    } catch (error: unknown) {
      console.error('Error refreshing file metadata', error);
      // Gesture-less, so log-only — the same rule the invalidation route's own
      // directory pass already follows, now applied to the listing this half
      // issues (ADR-031 §D9).
      if (background) return;
      // File-scoped, despite fetching a DIRECTORY listing: this listing is
      // issued on behalf of the open file's chrome, and it is the pane that has
      // stale metadata when it fails. Routing it to `treeError` would blank the
      // navigator over one file's size tag — `backlog.md` row 19.
      const message = error instanceof Error ? error.message : '';
      this.fileError.set(message || 'Failed to refresh file metadata');
    }
  }

  downloadFile() {
    const selected = this.openFile();
    if (!selected) return;

    const url = this.workspaceService.getDownloadUrl(
      this.processId,
      selected.path,
      this.workspaceId()
    );
    window.open(url, '_blank');
  }

  formatFileSize(bytes: number | undefined): string {
    if (!bytes) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Re-read the whole workspace. `background` defaults to the gesture value so
   * the navigator's `(onClick)="refresh()"` keeps bannering a failed root load;
   * the invalidation route is the only caller that passes `true`.
   */
  refresh(background: boolean = false) {
    // Re-run the root load for the current workspaceId via the declarative
    // stream (the only owner of the loading/treeNodes lifecycle now).
    this.loadRootTree$(this.workspaceId(), background)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        this.applyRootLoad(result);
        this.applyRootListing(result);
      });

    // The workspace-scoped control also re-reads whatever file is open, through
    // the same per-file path — refreshing the tree while leaving the pane on
    // stale bytes is the surprise this closes.
    if (this.openFile()) {
      void this.refreshSelectedFile(background);
    }
  }

  toggleSidebar() {
    this.sidebarVisible = !this.sidebarVisible;
  }

  onNavigatorHover() {
    // Only expand on hover if collapsed
    if (!this.sidebarVisible) {
      this.sidebarVisible = true;
    }
  }

  onNavigatorLeave() {
    // Auto-collapse when mouse leaves the panel
    this.sidebarVisible = false;
  }

  openUploadModal(targetPath?: string) {
    this.uploadTargetPath = targetPath || '';
    this.uploadModalVisible = true;
  }

  private getParentPath(filePath: string): string {
    if (!filePath) return '';
    const parts = filePath.split('/');
    parts.pop(); // Remove the file name
    return parts.join('/');
  }

  async handleUploadComplete() {
    // Get selected files from the modal
    const files = this.uploadModal.getSelectedFiles();

    if (files.length === 0) {
      return;
    }

    try {
      await this.workspaceService.uploadFiles(
        this.processId,
        files,
        this.uploadTargetPath,
        this.workspaceId()
      );

      // Refresh ONLY the directory the user uploaded to — preserves the
      // rest of the user's expansion state. Root ('') replaces `treeNodes`
      // wholesale; subdirs are located via `findTreeNodeByPath`.
      await this.refreshDirectory(this.uploadTargetPath);
    } catch (error: any) {
      console.error('Upload failed', error);
      throw error;
    }
  }

  /**
   * Re-fetch a single directory listing and put the fresh children back into
   * the tree at that path.
   *
   * The root ('') and a subdirectory stay distinguishable — an array
   * REPLACEMENT versus a node splice — but for a different reason than before:
   * the root's children ARE `treeNodes`, so there is no node to look up and no
   * wrapper to preserve. For a subdirectory we walk the tree to locate the
   * matching TreeNode; if not found (e.g. the user uploaded to a directory that
   * has not been expanded yet), the splice is skipped — the next manual expand
   * lazy-fetches the fresh listing anyway.
   *
   * Returns the fresh listing so a caller that needs a single entry out of it
   * (the per-file refresh, re-resolving the open file's metadata) can read it
   * without issuing a second request or duplicating the splice.
   *
   * The main pane's list is a THIRD reader of that same response: when this
   * listing is for the directory the pane is showing, it is written straight
   * into `listing` (ADR-033 §D2). No fetch is added anywhere by that — the
   * invalidation route, the upload path and the metadata half all already make
   * this call, so the directory the user is looking at stays current at zero
   * extra cost and no `getWorkspaceTree` count moves.
   */
  private async refreshDirectory(path: string): Promise<FileNode[]> {
    const fresh = await this.fetchTree(path);
    const freshNodes = this.convertToTreeNodes(fresh);

    // Compared at RESOLUTION time, like every other listing write: the user can
    // navigate away while this is in flight.
    if (path === this.currentDirectory()) {
      this.listing.set({ path, entries: fresh });
    }

    if (path === '') {
      this.treeNodes.set(freshNodes);
      return fresh;
    }

    const current = this.treeNodes();
    const target = this.findTreeNodeByPath(current, path);
    if (target) {
      target.children = freshNodes;
      this.treeNodes.set([...current]);
    }
    return fresh;
  }

  /**
   * Recursive depth-first walk locating the TreeNode whose `data.path`
   * matches `path`. Returns `null` if no match exists in the currently
   * materialized tree (lazy: unloaded subtrees are invisible to this walk).
   */
  private findTreeNodeByPath(
    nodes: TreeNode[],
    path: string
  ): TreeNode | null {
    for (const n of nodes) {
      const fn = n.data as FileNode | undefined;
      if (fn?.path === path) return n;
      if (n.children) {
        const found = this.findTreeNodeByPath(n.children, path);
        if (found) return found;
      }
    }
    return null;
  }
}
