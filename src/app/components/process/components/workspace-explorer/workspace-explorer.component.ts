import {
  ChangeDetectionStrategy,
  Component,
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
import { UploadModalComponent } from './upload-modal/upload-modal.component';

/**
 * Outcome of one declarative root-tree load. `switchMap` maps each
 * `workspaceId` emission to a stream of these so the subscriber only ever
 * applies the LATEST load's result — a superseded slow response is cancelled
 * before it can clobber a newer tab's tree (ADR-021 §Decision 2, race closure).
 */
interface RootLoadResult {
  nodes: TreeNode[] | null;
  error: string | null;
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
  selectedFile = signal<FileNode | null>(null);
  selectedFolder = signal<FileNode | null>(null);
  fileContent = signal<string | null>(null);
  loading = signal(false);
  loadingContent = signal(false);
  isBinaryFile = signal(false);
  isMarkdownFile = signal(false);
  errorMessage = signal<string | null>(null);

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
      .subscribe((result) => this.applyRootLoad(result));
  }

  /**
   * Map one `workspaceId` value to a root-load stream that drives the loading
   * spinner on subscribe, resolves to the synthetic Root Folder wrapper on
   * success, and maps a rejection to an error message. Returns an empty
   * (no-op) load when `processId` is not yet resolved.
   */
  private loadRootTree$(ws?: string) {
    if (!this.processId) {
      return of<RootLoadResult>({ nodes: null, error: null });
    }

    this.loading.set(true);
    this.errorMessage.set(null);

    return from(this.fetchTree('', ws)).pipe(
      map((tree): RootLoadResult => ({ nodes: this.wrapRootTree(tree), error: null })),
      catchError((error: any) => {
        console.error('Error loading workspace', error);
        return of<RootLoadResult>({
          nodes: null,
          error: error?.message || 'Failed to load workspace',
        });
      }),
      tap(() => this.loading.set(false)),
    );
  }

  /** Apply the latest (switchMap-guarded) root-load result to the signals. */
  private applyRootLoad(result: RootLoadResult): void {
    if (result.error !== null) {
      this.errorMessage.set(result.error);
      return;
    }
    if (result.nodes !== null) {
      this.treeNodes.set(result.nodes);
    }
  }

  /** Wrap converted backend entries in the synthetic Root Folder node. */
  private wrapRootTree(tree: FileNode[]): TreeNode[] {
    const rootNode: TreeNode = {
      label: 'Root Folder',
      data: { name: 'Root Folder', path: '', type: 'directory' } as FileNode,
      icon: 'pi pi-home',
      children: this.convertToTreeNodes(tree),
      expanded: true,
      selectable: true,
    };
    return [rootNode];
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
      this.errorMessage.set(error?.message || 'Failed to load subdirectory');
      // Leave node.children as undefined so a subsequent user-initiated
      // expand can retry the fetch.
    }
  }

  async onNodeSelect(event: any) {
    const node: FileNode = event.node.data;

    if (node.type === 'file') {
      this.selectedFile.set(node);
      this.selectedFolder.set(null);
      await this.loadFileContent(node.path);
    } else if (node.type === 'directory') {
      this.selectedFile.set(null);
      this.selectedFolder.set(node);
      this.fileContent.set(null);
      this.isBinaryFile.set(false);
      this.isMarkdownFile.set(false);
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
   *   so it is left rendered while the new bytes are fetched. `fileContent` is
   *   never nulled and `loadingContent` is never raised — that, and nothing
   *   else, is what preserves the reader's scroll position (ADR-030 §D2). The
   *   binary/markdown flags are written from the RESULT rather than reset up
   *   front, because resetting them mid-flight flips the template blocks and
   *   flickers the pane.
   *
   * `errorMessage` is cleared on entry in both modes, so a refresh that
   * succeeds after a failure clears the stale banner.
   *
   * A read that a NEWER read has already superseded writes nothing on the way
   * out either: not the body (see `applyFileContent`), not the error banner and
   * not the spinner. All three are the same race, and all three become routine
   * rather than rare once reads start firing from the event stream with no user
   * gesture behind them.
   */
  async loadFileContent(path: string, refresh: boolean = false) {
    const token = ++this.readToken;
    if (!refresh) {
      this.loadingOwner = token;
      this.loadingContent.set(true);
      this.fileContent.set(null);
      this.isBinaryFile.set(false);
      this.isMarkdownFile.set(false);
    }
    this.errorMessage.set(null);

    try {
      const result: FileContent = await this.workspaceService.getFileContent(
        this.processId,
        path,
        this.workspaceId()
      );
      this.applyFileContent(result, path);
    } catch (error: any) {
      console.error('Error loading file content', error);
      // A superseded read's failure must not banner over a file the user is
      // now reading successfully. Supersession — not the pane's path rule — is
      // the test here, because `errorMessage` is shared with the tree loads and
      // a read issued against no selection at all is still this banner's to set.
      if (token === this.readToken) {
        this.errorMessage.set(error?.message || 'Failed to load file content');
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
   * `requestedPath` is the path the read was ISSUED for; `selectedFile()` is
   * read at RESOLUTION time. They differ exactly when the response has been
   * superseded, and then NOTHING is written: not `fileContent`, not
   * `isBinaryFile`, not `isMarkdownFile`. Otherwise a slow read of file A that
   * loses the race still wins the write, and the pane renders A's bytes under
   * B's name and size tag — chrome disagreeing with the pane it labels, which
   * reads as authoritative because it looks deliberate (ADR-030 §A4).
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
   * - **No selection means no application.** With `selectedFile()` null there is
   *   no pane to write into — including the case where the user selected a
   *   *directory* while a file read was in flight. Both production entry points
   *   establish or require `selectedFile` before issuing a read, so a read with
   *   no selection is reachable only by driving this loader directly.
   * - **Compare paths, never `FileNode` identity.** A refresh replaces
   *   `selectedFile` with a fresh instance carrying the same path; an identity
   *   comparison would discard every refresh result.
   */
  private applyFileContent(result: FileContent, requestedPath: string): void {
    if (requestedPath !== this.selectedFile()?.path) return;

    if (result.type === 'binary') {
      this.isBinaryFile.set(true);
      this.isMarkdownFile.set(false);
      this.fileContent.set(result.message || 'Binary file cannot be displayed');
      return;
    }
    this.isBinaryFile.set(false);
    this.fileContent.set(result.content);
    this.isMarkdownFile.set(this.isMarkdownPath(requestedPath));
  }

  /**
   * Markdown-ness of the path a read was issued for. The renderer has to follow
   * the bytes it is rendering, so this is decided by the request rather than by
   * whatever `selectedFile()` holds when the response lands — and by the path
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
   * The body is read FIRST so its `errorMessage` reset cannot wipe a listing
   * failure reported by the metadata half.
   */
  async refreshSelectedFile(): Promise<void> {
    const file = this.selectedFile();
    if (!file) return;

    // Enforce in code the gate the toolbar control applies in the template: the
    // workspace-scoped refresh reaches this method too and its button is NOT
    // bound to these signals. Two reads of the same file settle in arbitrary
    // order, so the loser repaints the pane with the OLDER bytes, and the first
    // `finally` would release the button while the second read is still live.
    if (this.refreshingFile() || this.loadingContent()) return;

    this.refreshingFile.set(true);
    try {
      await this.loadFileContent(file.path, true);
      await this.refreshFileMetadata(file);
    } finally {
      this.refreshingFile.set(false);
    }
  }

  /**
   * Re-fetch the open file's parent listing through the existing
   * `refreshDirectory` (which already splices fresh children into the
   * materialized tree and tolerates a target that was never expanded), then
   * re-resolve the open file's own entry by path. A path absent from the fresh
   * listing leaves `selectedFile` as it is — the failed body read is what tells
   * the user the file has gone. A rejection here is reported and swallowed so
   * it cannot cancel the other half.
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
  private async refreshFileMetadata(file: FileNode): Promise<void> {
    try {
      const fresh = await this.refreshDirectory(this.getParentPath(file.path));
      const entry = fresh.find((node) => node.path === file.path);
      if (entry && this.selectedFile()?.path === file.path) {
        this.selectedFile.set(entry);
      }
    } catch (error: unknown) {
      console.error('Error refreshing file metadata', error);
      const message = error instanceof Error ? error.message : '';
      this.errorMessage.set(message || 'Failed to refresh file metadata');
    }
  }

  downloadFile() {
    const selected = this.selectedFile();
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

  refresh() {
    // Re-run the root load for the current workspaceId via the declarative
    // stream (the only owner of the loading/treeNodes lifecycle now).
    this.loadRootTree$(this.workspaceId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.applyRootLoad(result));

    // The workspace-scoped control also re-reads whatever file is open, through
    // the same per-file path — refreshing the tree while leaving the pane on
    // stale bytes is the surprise this closes.
    if (this.selectedFile()) {
      void this.refreshSelectedFile();
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

  openUploadModalToCurrentSelection() {
    const folder = this.selectedFolder();
    const file = this.selectedFile();
    // If a folder is selected, upload there
    if (folder) {
      this.openUploadModal(folder.path);
    }
    // If a file is selected, upload to its parent folder
    else if (file) {
      const parentPath = this.getParentPath(file.path);
      this.openUploadModal(parentPath);
    }
    // Otherwise upload to root
    else {
      this.openUploadModal();
    }
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
      // rest of the user's expansion state. Root ('') targets the synthetic
      // Root Folder wrapper; subdirs are located via `findTreeNodeByPath`.
      await this.refreshDirectory(this.uploadTargetPath);
    } catch (error: any) {
      console.error('Upload failed', error);
      throw error;
    }
  }

  /**
   * Re-fetch a single directory listing and splice the fresh children into
   * the tree at that path. For the root ('') this replaces the synthetic
   * Root Folder wrapper's children (the wrapper itself stays). For subdirs
   * we walk the tree to locate the matching TreeNode; if not found (e.g.
   * user uploaded to a dir that hasn't been expanded yet), the splice is
   * skipped — the next manual expand will lazy-fetch the fresh listing anyway.
   *
   * Returns the fresh listing so a caller that needs a single entry out of it
   * (the per-file refresh, re-resolving the open file's metadata) can read it
   * without issuing a second request or duplicating the splice.
   */
  private async refreshDirectory(path: string): Promise<FileNode[]> {
    const fresh = await this.fetchTree(path);
    const freshNodes = this.convertToTreeNodes(fresh);

    const current = this.treeNodes();
    const target =
      path === ''
        ? current[0] ?? null
        : this.findTreeNodeByPath(current, path);

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
