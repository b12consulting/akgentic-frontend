import {
  Component,
  EventEmitter,
  inject,
  Input,
  Output,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { FileUpload, FileUploadModule } from 'primeng/fileupload';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressBarModule } from 'primeng/progressbar';
import { MessageModule } from 'primeng/message';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-upload-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    ButtonModule,
    FileUploadModule,
    InputTextModule,
    ProgressBarModule,
    MessageModule,
    TranslatePipe,
  ],
  templateUrl: './upload-modal.component.html',
  styleUrls: ['./upload-modal.component.scss'],
})
export class UploadModalComponent {
  @Input() visible = false;
  @Input() targetPath: string = '';
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() uploadComplete = new EventEmitter<void>();

  @ViewChild(FileUpload) fileUpload!: FileUpload;

  /* These three sentences are rendered into a p-message's `[text]`, not into a
   * template expression, so they cannot go through the pipe — they go through
   * the service instead. They are user-visible copy either way. */
  private readonly translate = inject(TranslateService);

  selectedFiles: File[] = [];
  uploading = false;
  uploadProgress = 0;
  errorMessage: string | null = null;
  successMessage: string | null = null;

  /* A folder to create under `targetPath`, named in the dialog. The upload
   * itself creates it: the backend makes missing parents when it writes. */
  newFolderOpen = false;
  newFolderName = '';

  /** The trimmed new-folder name when it is one valid segment, else null. */
  get newFolderSegment(): string | null {
    if (!this.newFolderOpen) return null;
    const name = this.newFolderName.trim();
    if (name === '' || name === '.' || name === '..') return null;
    if (name.includes('/') || name.includes('\\')) return null;
    return name;
  }

  /** The input is open with a name that cannot be used: block the upload. */
  get newFolderInvalid(): boolean {
    return this.newFolderOpen && this.newFolderSegment === null;
  }

  openNewFolder() {
    this.newFolderOpen = true;
  }

  clearNewFolder() {
    this.newFolderName = '';
    this.newFolderOpen = false;
  }

  onHide() {
    this.visible = false;
    this.visibleChange.emit(false);
    this.resetModal();
  }

  onSelect(event: any) {
    this.selectedFiles = event.currentFiles;
    this.errorMessage = null;
    this.successMessage = null;
  }

  onRemove(event: any) {
    this.selectedFiles = this.selectedFiles.filter((f) => f !== event.file);
  }

  onClear() {
    this.selectedFiles = [];
    this.errorMessage = null;
    this.successMessage = null;
  }

  async uploadFiles() {
    if (this.selectedFiles.length === 0) {
      this.errorMessage = this.translate.instant('workspace.upload.errNoFiles');
      return;
    }

    this.uploading = true;
    this.uploadProgress = 0;
    this.errorMessage = null;
    this.successMessage = null;

    try {
      // Emit the upload event with files
      // The parent component will handle the actual upload
      this.uploadComplete.emit();
      this.successMessage = this.translate.instant('workspace.upload.success', {
        count: this.selectedFiles.length,
      });

      // Auto-close after success
      setTimeout(() => {
        this.onHide();
      }, 1500);
    } catch (error: any) {
      this.errorMessage =
        error?.message || this.translate.instant('workspace.upload.errFailed');
    } finally {
      this.uploading = false;
      this.uploadProgress = 100;
    }
  }

  private resetModal() {
    // Clear the PrimeNG widget's internal files array first. The optional
    // chain guards against the ViewChild being undefined when the dialog
    // content has not yet been rendered (see issue #75 / Story 6-3 AC5).
    this.fileUpload?.clear();
    this.selectedFiles = [];
    this.uploading = false;
    this.uploadProgress = 0;
    this.errorMessage = null;
    this.successMessage = null;
    this.clearNewFolder();
  }

  getSelectedFiles(): File[] {
    return this.selectedFiles;
  }

  /** Where the files go: `targetPath`, plus the new folder when one is named. */
  getEffectiveTargetPath(): string {
    const segment = this.newFolderSegment;
    if (segment === null) return this.targetPath;
    return this.targetPath === '' ? segment : `${this.targetPath}/${segment}`;
  }

  formatFileSize(bytes: number): string {
    if (!bytes) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}
