import { inject, Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { FetchService } from './fetch.service';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  modified?: string;
  extension?: string;
}

export interface FileContent {
  content: string | null;
  type: 'text' | 'binary';
  message?: string;
}

export interface WorkspaceStats {
  total_files: number;
  total_size: number;
  file_types: { [key: string]: number };
  last_modified: string;
}

@Injectable({
  providedIn: 'root',
})
export class WorkspaceService {
  fetchService: FetchService = inject(FetchService);
  private apiUrl = environment.api;

  async getWorkspaceTree(processId: string): Promise<FileNode[]> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/workspace/${processId}/tree`,
    });
    return response ?? [];
  }

  async getFileContent(
    processId: string,
    filePath: string
  ): Promise<FileContent> {
    const response = await this.fetchService.fetch({
      url: `${
        this.apiUrl
      }/workspace/${processId}/file?path=${encodeURIComponent(filePath)}`,
    });
    return response;
  }

  getDownloadUrl(processId: string, filePath: string): string {
    return `${
      this.apiUrl
    }/workspace/${processId}/download?path=${encodeURIComponent(filePath)}`;
  }

  async getWorkspaceStats(processId: string): Promise<WorkspaceStats> {
    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/workspace/${processId}/stats`,
    });
    return response;
  }

  async uploadFiles(
    processId: string,
    files: File[],
    targetPath?: string
  ): Promise<void> {
    const formData = new FormData();

    files.forEach((file) => {
      formData.append('files', file);
    });

    if (targetPath) {
      formData.append('targetPath', targetPath);
    }

    const response = await this.fetchService.fetch({
      url: `${this.apiUrl}/workspace/${processId}/upload`,
      options: {
        method: 'POST',
        body: formData,
      },
    });

    return response;
  }
}
