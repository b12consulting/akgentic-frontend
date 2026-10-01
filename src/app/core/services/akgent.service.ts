import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export class Akgent {
  name!: string;
  agentId!: string;
}

@Injectable({
  providedIn: 'root',
})
export class AkgentService {
  selectedAkgent$: BehaviorSubject<Akgent | null> =
    new BehaviorSubject<Akgent | null>(null);

  select(agentId: string, actorName: string): void {
    this.selectedAkgent$.next({
      name: actorName,
      agentId: agentId,
    });
  }

  unselect(): void {
    this.selectedAkgent$.next(null);
  }
}
