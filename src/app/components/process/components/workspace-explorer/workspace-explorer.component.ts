import {
  Component,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
  inject,
  ViewChild,
} from '@angular/core';
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
import { firstValueFrom } from 'rxjs';
import {
  WorkspaceService,
  FileNode,
  FileContent,
} from '../../workspace/workspace.service';
import { ContextService } from '../../../../core/context/context.service';
import { UploadModalComponent } from './upload-modal/upload-modal.component';

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
})
export class WorkspaceExplorerComponent implements OnInit, OnChanges {
  @ViewChild(UploadModalComponent) uploadModal!: UploadModalComponent;

  /**
   * Optional workspace addressed by this explorer (Epic 23 / ADR-019). Unset
   * (the default tab / today's behaviour) ⇒ every WorkspaceService call omits
   * `workspaceId`, so the backend falls back to `team_id`. When bound to a
   * value it is threaded through every call; a later change refetches the tree.
   */
  @Input() workspaceId?: string;

  workspaceService = inject(WorkspaceService);
  contextService = inject(ContextService);

  processId: string = '';
  isProcessRunning: boolean = false;

  treeNodes: TreeNode[] = [];
  selectedFile: FileNode | null = null;
  selectedFolder: FileNode | null = null;
  fileContent: string | null = null;
  loading = false;
  loadingContent = false;
  isBinaryFile = false;
  isMarkdownFile = false;
  errorMessage: string | null = null;
  sidebarVisible = false; // Start collapsed
  uploadModalVisible = false;
  uploadTargetPath: string = '';

  async ngOnInit() {
    this.processId = this.contextService.currentProcessId$.value;
    await this.checkProcessStatus();
    this.loadWorkspace();
  }

  /**
   * Refetch the tree when the bound `workspaceId` switches AFTER init. The
   * first (init) input arrival is `firstChange` and is handled by ngOnInit's
   * loadWorkspace — guarding on `!firstChange` avoids a double initial fetch.
   * A change that does not alter the value is skipped (no redundant refetch).
   */
  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['workspaceId'];
    if (!change || change.firstChange) return;
    if (change.currentValue === change.previousValue) return;
    this.loadWorkspace();
  }

  /**
   * Fetch a directory listing, threading `workspaceId` only when set so the
   * unset path keeps today's 2-arg call shape (and byte-identical URL).
   */
  private fetchTree(path: string): Promise<FileNode[]> {
    return this.workspaceId
      ? this.workspaceService.getWorkspaceTree(this.processId, path, this.workspaceId)
      : this.workspaceService.getWorkspaceTree(this.processId, path);
  }

  async checkProcessStatus() {
    this.isProcessRunning = await firstValueFrom(
      this.contextService.currentTeamRunning$,
    );
  }

  async loadWorkspace() {
    if (!this.processId) return;

    this.loading = true;
    this.errorMessage = null;

    try {
      const tree = await this.fetchTree('');
      const fileNodes = this.convertToTreeNodes(tree);

      // Add root node at the top
      const rootNode: TreeNode = {
        label: 'Root Folder',
        data: { name: 'Root Folder', path: '', type: 'directory' } as FileNode,
        icon: 'pi pi-home',
        children: fileNodes,
        expanded: true,
        selectable: true,
      };

      this.treeNodes = [rootNode];
    } catch (error: any) {
      console.error('Error loading workspace', error);
      this.errorMessage = error?.message || 'Failed to load workspace';
    } finally {
      this.loading = false;
    }
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
      // Re-assign the top-level array reference so Angular's default CD
      // picks up the mutation on a nested TreeNode's `children` property.
      this.treeNodes = [...this.treeNodes];
    } catch (error: any) {
      console.error('Error loading subdirectory', error);
      this.errorMessage = error?.message || 'Failed to load subdirectory';
      // Leave node.children as undefined so a subsequent user-initiated
      // expand can retry the fetch.
    }
  }

  async onNodeSelect(event: any) {
    const node: FileNode = event.node.data;

    if (node.type === 'file') {
      this.selectedFile = node;
      this.selectedFolder = null;
      await this.loadFileContent(node.path);
    } else if (node.type === 'directory') {
      this.selectedFile = null;
      this.selectedFolder = node;
      this.fileContent = null;
      this.isBinaryFile = false;
      this.isMarkdownFile = false;
    }
  }

  async loadFileContent(path: string) {
    this.loadingContent = true;
    this.fileContent = null;
    this.isBinaryFile = false;
    this.isMarkdownFile = false;
    this.errorMessage = null;

    try {
      const result: FileContent = await this.workspaceService.getFileContent(
        this.processId,
        path,
        this.workspaceId
      );

      if (result.type === 'binary') {
        this.isBinaryFile = true;
        this.fileContent = result.message || 'Binary file cannot be displayed';
      } else {
        this.fileContent = result.content;
        // Check if file is markdown
        if (this.selectedFile?.extension?.toLowerCase() === '.md') {
          this.isMarkdownFile = true;
        }
      }
    } catch (error: any) {
      console.error('Error loading file content', error);
      this.errorMessage = error?.message || 'Failed to load file content';
    } finally {
      this.loadingContent = false;
    }
  }

  downloadFile() {
    if (!this.selectedFile) return;

    const url = this.workspaceService.getDownloadUrl(
      this.processId,
      this.selectedFile.path,
      this.workspaceId
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
    this.loadWorkspace();
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
    // If a folder is selected, upload there
    if (this.selectedFolder) {
      this.openUploadModal(this.selectedFolder.path);
    }
    // If a file is selected, upload to its parent folder
    else if (this.selectedFile) {
      const parentPath = this.getParentPath(this.selectedFile.path);
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
        this.workspaceId
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
   * user uploaded to a dir that hasn't been expanded yet), silently return —
   * the next manual expand will lazy-fetch the fresh listing anyway.
   */
  private async refreshDirectory(path: string): Promise<void> {
    const fresh = await this.fetchTree(path);
    const freshNodes = this.convertToTreeNodes(fresh);

    if (path === '') {
      if (this.treeNodes.length > 0) {
        this.treeNodes[0].children = freshNodes;
        this.treeNodes = [...this.treeNodes];
      }
      return;
    }

    const target = this.findTreeNodeByPath(this.treeNodes, path);
    if (target) {
      target.children = freshNodes;
      this.treeNodes = [...this.treeNodes];
    }
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
