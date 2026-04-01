import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface TeamConfig {
  [teamName: string]: {
    module: string;
    setup: string;
  };
}

@Injectable({
  providedIn: 'root',
})
export class TeamsService {
  httpClient: HttpClient = inject(HttpClient);

  getTeamConfigs(): Observable<TeamConfig> {
    return this.httpClient.get<TeamConfig>(`${environment.api}/team-configs`);
  }
}
