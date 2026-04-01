import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { ApiService } from './api.service';
import { ProcessContext } from '../models/process.interface';

@Injectable({
  providedIn: 'root',
})
export class ContextService {
  apiService: ApiService = new ApiService();
  router: Router = inject(Router);
  currentProcessId$ = new BehaviorSubject<string>('');

  _context: ProcessContext[] = [];

  async getContext(): Promise<ProcessContext[]> {
    this._context = await this.apiService.getContext();
    return this._context;
  }

  async getCurrentProcess(
    processId: string,
    useCache: boolean = true
  ): Promise<ProcessContext | null> {
    // Look for the process in the cache
    if (useCache) {
      const cachedProcess = this._context.find(
        (i: ProcessContext) => i.id === processId
      );
      if (cachedProcess) {
        return cachedProcess;
      }
    }

    // Get the process from the API
    const process = await this.apiService.getProcess(processId);

    // replace the entry in the context cache
    this._context = this._context.map((i: ProcessContext) =>
      i.id === processId ? process : i
    );

    return process;
  }

  async deleteCurrentProcess(team_id: string): Promise<void> {
    await this.apiService.deleteProcess(team_id);
  }

  // Delete the current process and create a new one of the specified type
  // Then navigate to the new process
  async clear(processId: string) {
    await this.deleteCurrentProcess(processId);
    await this.router.navigate(['/']);
  }

  async createProcessAndNavigate(processType: string) {
    await this.apiService.createProcess(processType, 'default');
    await this.getContext().then((context) => {
      const len = context.length;
      const processId = context[len - 1].id;
      return this.router.navigate(['/process', processId]).then(() => {
        window.location.reload();
      });
    });
  }
}
