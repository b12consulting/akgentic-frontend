// frontend/src/app/home/config-editor/config-editor.component.ts

import { CommonModule } from '@angular/common';
import {
  Component,
  inject,
  Input,
  OnInit,
  NgZone,
  Output,
  EventEmitter,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { InputTextModule } from 'primeng/inputtext';
import { NuMonacoEditorModule } from '@ng-util/monaco-editor';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';

@Component({
  selector: 'app-config-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SelectModule,
    DialogModule,
    DropdownModule,
    InputTextModule,
    NuMonacoEditorModule,
    TooltipModule,
  ],
  templateUrl: './config-editor.component.html',
  styleUrls: ['./config-editor.component.scss'],
})
export class ConfigEditorComponent implements OnInit {
  @Input() processType!: string | null;
  @Output() onConfigUpdate = new EventEmitter<any>();
  @Output() onSaveEvent = new EventEmitter<void>();

  apiService: ApiService = inject(ApiService);
  zone: NgZone = inject(NgZone);

  config$ = new BehaviorSubject<string>('');
  configData$ = new BehaviorSubject<any[]>([]);
  selectedConfig$ = new BehaviorSubject<any>(null);
  unchanged: boolean = false;
  newConfigName: string = ''; // For the creation of new configuration

  // Editor options for Monaco editor. /!\ automaticLayout !!!
  editorOptions = {
    theme: 'vs',
    language: 'yaml',
    automaticLayout: true,
  };

  ngOnInit() {
    this.loadConfig();
    this.selectedConfig$.subscribe((config) => {
      if (config && config.config !== undefined) {
        this.config$.next(config.config);
      }
    });
  }

  async loadConfig() {
    if (!this.processType) {
      console.warn('No process type provided, skipping config load.');
      return;
    }
    const configs = await this.apiService.getConfig(this.processType);
    this.configData$.next(configs);
    if (configs.length > 0) {
      this.selectedConfig$.next(configs[0]);
      this.config$.next(configs[0].config);
    }
  }

  onConfigChange(config: any) {
    this.selectedConfig$.next(config);
    if (config && config.config !== undefined) {
      this.config$.next(config.config);
    }
  }

  onConfigModelChange(event: any) {
    this.zone.run(() => {
      const selected = this.selectedConfig$.value;
      this.unchanged = selected && event === selected.config;
      this.config$.next(event);
    });
  }

  showEvent(event: any) {
    console.log('showEvent:', event);
  }

  onReset() {
    const selected = this.selectedConfig$.value;
    if (selected) {
      this.config$.next(selected.config);
    }
  }

  async onSaveNew() {
    await this.apiService.saveConfig(
      this.processType!,
      null,
      this.newConfigName,
      this.config$.value,
    );
    this.newConfigName = '';
    await this.loadConfig();
    this.onConfigUpdate.emit();
    // Select the new entry
    const configs = this.configData$.value;
    if (configs.length > 0) {
      this.selectedConfig$.next(configs[configs.length - 1]);
      this.config$.next(configs[configs.length - 1].config);
    }
    this.onSaveEvent.emit();
  }

  async onCheck() {
    await this.apiService.saveConfig(
      this.processType!,
      null,
      null,
      this.config$.value,
      true,
    );
  }

  async onSave() {
    const selected = this.selectedConfig$.value;
    await this.apiService.saveConfig(
      this.processType!,
      selected?.id,
      null,
      this.config$.value,
    );
    this.onSaveEvent.emit();
  }

  async onDelete() {
    const selected = this.selectedConfig$.value;
    await this.apiService.deleteConfig(this.processType!, selected?.id);
    await this.loadConfig();
    this.onConfigUpdate.emit();
    this.onSaveEvent.emit();
  }

  openDocumentation() {
    window.open('/config_factory.html', '_blank');
  }
}
