import { TestBed } from '@angular/core/testing';
import { Observable } from 'rxjs';

import { AkgentService } from '../../akgent.service';
import { SELECTED_AGENT_ID } from '../event/selected-agent';
import { PROCESS_PROVIDERS } from './process.providers';

describe('PROCESS_PROVIDERS — the selection stream (Epic 56)', () => {
  it('binds SELECTED_AGENT_ID to the root AkgentService selection', () => {
    // Providers resolve lazily, so only the token and its root dependency are
    // constructed here — none of the team stack's own dependencies.
    TestBed.configureTestingModule({ providers: [...PROCESS_PROVIDERS] });
    const selected$: Observable<string | null> = TestBed.inject(SELECTED_AGENT_ID);
    const akgents = TestBed.inject(AkgentService);
    const seen: (string | null)[] = [];
    const sub = selected$.subscribe((id) => seen.push(id));

    akgents.select('agent-uuid-1', '@Researcher');
    akgents.unselect();
    sub.unsubscribe();

    // The first `null` is the BehaviorSubject's current value on subscribe.
    expect(seen).toEqual([null, 'agent-uuid-1', null]);
  });
});
