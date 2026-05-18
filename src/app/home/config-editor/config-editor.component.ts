// frontend/src/app/home/config-editor/config-editor.component.ts

import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { NamespaceSummary } from '../../models/catalog.interface';

@Component({
  selector: 'app-config-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    TagModule,
  ],
  templateUrl: './config-editor.component.html',
  styleUrls: ['./config-editor.component.scss'],
})
export class ConfigEditorComponent implements OnInit {
  apiService: ApiService = inject(ApiService);

  namespaces$ = new BehaviorSubject<NamespaceSummary[]>([]);
  loading = false;

  ngOnInit() {
    this.loadNamespaces();
  }

  async loadNamespaces() {
    this.loading = true;
    try {
      const namespaces = await this.apiService.getNamespaces();
      this.namespaces$.next(namespaces);
    } catch (error) {
      console.error('Failed to load namespaces:', error);
    } finally {
      this.loading = false;
    }
  }
}
