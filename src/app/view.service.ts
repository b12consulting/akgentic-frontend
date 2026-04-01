import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../environments/environment';

const INITIAL_COLLAPSED = environment.initRightPanelCollapsed;
@Injectable({
  providedIn: 'root',
})
export class ViewService {
  isRightColumnCollapsed$ = new BehaviorSubject<boolean>(INITIAL_COLLAPSED);

  toggleRightColumn(): void {
    this.isRightColumnCollapsed$.next(!this.isRightColumnCollapsed$.value);
  }
}
