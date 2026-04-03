import { Component, OnInit, inject, ViewChild } from '@angular/core';
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
import {
  WorkspaceService,
  FileNode,
  FileContent,
} from '../../services/workspace.service';
import { isRunning } from '../../models/team.interface';
import { ContextService } from '../../services/context.service';
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
export class WorkspaceExplorerComponent implements OnInit {
  @ViewChild(UploadModalComponent) uploadModal!: UploadModalComponent;

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

  async checkProcessStatus() {
    const process = await this.contextService.getCurrentTeam(this.processId);
    this.isProcessRunning = process ? isRunning(process) : false;
  }

  async loadWorkspace() {
    if (!this.processId) return;

    this.loading = true;
    this.errorMessage = null;

    try {
      const tree = await this.workspaceService.getWorkspaceTree(this.processId);
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
        path
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
      this.selectedFile.path
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
        this.uploadTargetPath
      );

      // Refresh the workspace tree
      await this.loadWorkspace();
    } catch (error: any) {
      console.error('Upload failed', error);
      throw error;
    }
  }
}
