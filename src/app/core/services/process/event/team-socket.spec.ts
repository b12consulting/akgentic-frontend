import { TestBed } from '@angular/core/testing';

import { Subject } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';

import { ConfigService } from '../../../platform/config/config.service';
import { AkgenticMessage } from '../../../protocol/message.types';
import { TeamSocket, TeamSocketStatus } from './team-socket';

// ---------------------------------------------------------------------------
// Story 34-6 (FR1, FR10) — `TeamSocket`, the transport source.
//
// The MINIMAL provider set is itself an assertion (ADR-025 §1): this unit
// depends on `ConfigService` and on NOTHING else. No `MessageLogService`, no
// `PerAgentStoreRegistry`, no PrimeNG `MessageService`, no `ApiService` — if
// `TeamSocket` ever grows a log, store or toast dependency, every test in this
// file fails at construction with `NullInjectorError`. Do not "fix" such a
// failure by widening the array below; that failure IS the boundary check.
// ---------------------------------------------------------------------------

function mkFrame(id: string): any {
  return {
    id,
    parent_id: null,
    team_id: 'team-1',
    timestamp: '2026-08-14T00:00:00Z',
    sender: {
      __actor_address__: true,
      name: '@X',
      role: 'Worker',
      agent_id: 'a1',
      squad_id: 's1',
      user_message: false,
    },
    display_type: 'other',
    content: null,
    __model__: 'akgentic.core.messages.orchestrator.StartMessage',
  };
}

function setup(api = 'http://api.example.com'): {
  socket: TeamSocket;
  fake: Subject<any>;
  created: string[];
} {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [TeamSocket, { provide: ConfigService, useValue: { api } }],
  });
  const socket = TestBed.inject(TeamSocket);
  const fake = new Subject<any>();
  const created: string[] = [];
  (socket as any).createWebSocket = (url: string) => {
    created.push(url);
    return fake as unknown as WebSocketSubject<any>;
  };
  return { socket, fake, created };
}

/**
 * A transport whose close is delivered on a LATER task, as a browser's `onclose`
 * is. `unsubscribe()` only SCHEDULES the completion; under `jasmine.clock()` it
 * lands on `tick(0)`, i.e. after whatever the spec does next — which is how the
 * sequence "stop old → subscribe new cycle → old close arrives" becomes real.
 *
 * `subscribe` returns the stream's own `Subscription` on purpose: that is what
 * `TeamSocket.start()` keeps and `stop()` detaches. A double whose `subscribe`
 * returned nothing could not tell a detaching `stop()` from one that only closes.
 */
function asyncClosingSocket(ending: 'complete' | 'error' = 'complete'): {
  socket: WebSocketSubject<any>;
  stream: Subject<any>;
  unsubscribed: () => number;
} {
  const stream = new Subject<any>();
  let count = 0;
  const socket = {
    subscribe: (observer: any) => stream.subscribe(observer),
    unsubscribe: () => {
      count++;
      setTimeout(() => {
        if (ending === 'complete') stream.complete();
        else stream.error(new Error('stale close'));
      }, 0);
    },
    next: (value: any) => stream.next(value),
  } as unknown as WebSocketSubject<any>;
  return { socket, stream, unsubscribed: () => count };
}

describe('TeamSocket — URL building (Story 34-6, AC2)', () => {
  it('builds ws:// from a plain page and strips the scheme off the api host', () => {
    const { socket, created } = setup('http://api.example.com');

    socket.start('proc-1');

    expect(created).toEqual(['ws://api.example.com/ws/proc-1']);
  });

  it('builds wss:// when the page itself is served over https', () => {
    const { socket, created } = setup('https://api.example.com');
    // `window.location` is a non-configurable own property in Chrome and the
    // Karma runner always serves over http:, so the `wss://` half of the
    // ternary is only reachable through the protected seam.
    (socket as any).pageProtocol = () => 'https:';

    socket.start('proc-1');

    expect(created).toEqual(['wss://api.example.com/ws/proc-1']);
  });

  it('leaves a scheme-less api host untouched (the regex tolerates both forms)', () => {
    const { socket, created } = setup('api.example.com:8000');

    socket.start('proc-42');

    expect(created).toEqual(['ws://api.example.com:8000/ws/proc-42']);
  });
});

describe('TeamSocket — the createWebSocket seam (Story 34-6, AC11)', () => {
  it('is overridable via spyOn (the form most of the suite uses)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        TeamSocket,
        { provide: ConfigService, useValue: { api: 'http://api.example.com' } },
      ],
    });
    const socket = TestBed.inject(TeamSocket);
    const fake = new Subject<any>();
    const spy = spyOn<any>(socket, 'createWebSocket').and.returnValue(
      fake as unknown as WebSocketSubject<any>,
    );

    socket.start('proc-1');

    expect(spy).toHaveBeenCalledWith('ws://api.example.com/ws/proc-1');
  });

  it('is overridable via direct assignment (the other form in use)', () => {
    const { socket, created } = setup();

    socket.start('proc-1');

    // `setup()` installs the seam by assignment; a real `webSocket()` would have
    // opened a TCP connection instead of recording the URL.
    expect(created.length).toBe(1);
  });
});

describe('TeamSocket — frame handling (Story 34-6, AC10)', () => {
  it('announces EVERY frame on frames$, including ones with no __model__', () => {
    const { socket, fake } = setup();
    const frames: number[] = [];
    const inbound: AkgenticMessage[] = [];
    socket.frames$.subscribe(() => frames.push(1));
    socket.inbound$.subscribe((m) => inbound.push(m));

    socket.start('proc-1');
    fake.next({ no_model: true });
    fake.next(null);
    fake.next(mkFrame('m-1'));

    // Three frames arrived; only one carried a discriminator. The spinner floor
    // rides on the first number — receiving bytes is proof the replay stream has
    // started, whatever shape they are.
    expect(frames.length).toBe(3);
    expect(inbound.map((m: any) => m.id)).toEqual(['m-1']);
  });

  it('announces the frame BEFORE pushing it onto the protocol stream', () => {
    const { socket, fake } = setup();
    const calls: string[] = [];
    socket.frames$.subscribe(() => calls.push('frame'));
    socket.inbound$.subscribe(() => calls.push('inbound'));

    socket.start('proc-1');
    fake.next(mkFrame('m-1'));

    // Order, not outcome: the spinner's every-frame tap must run ahead of the
    // log feed exactly as the inline `flipOnFirstEvent()` call did before the
    // handler moved into this file.
    expect(calls).toEqual(['frame', 'inbound']);
  });

  it('inbound$ subscribers land on the ONE hot subject (the leak probes read it)', () => {
    const { socket } = setup();
    const a = socket.inbound$.subscribe();
    const b = socket.inbound$.subscribe();

    const subject = (socket as any)._inbound$;
    expect(subject.observers.length).toBe(2);
    expect(subject.observed).toBeTrue();

    a.unsubscribe();
    b.unsubscribe();
    expect(subject.observers.length).toBe(0);
  });
});

describe('TeamSocket — connection status (Story 34-6, AC2)', () => {
  it('emits `error` and `complete` as DISTINCT members, never one signal', () => {
    const { socket, fake } = setup();
    const seen: TeamSocketStatus[] = [];
    socket.status$.subscribe((s) => seen.push(s));

    socket.start('proc-1');
    fake.error(new Error('connection refused'));

    expect(seen).toEqual(['error']);

    // A second cycle on a fresh stream completes cleanly instead.
    const other = new Subject<any>();
    (socket as any).createWebSocket = () =>
      other as unknown as WebSocketSubject<any>;
    socket.start('proc-2');
    other.complete();

    // The asymmetry is the point: the orchestrator flips the spinner on `error`
    // only. A single undifferentiated "disconnected" signal would collapse the
    // two and the spinner would survive a clean completion.
    expect(seen).toEqual(['error', 'complete']);
  });
});

describe('TeamSocket — lifecycle (Story 34-6, AC4, AC12)', () => {
  it('does NOTHING in its constructor — no socket, no subscription', () => {
    let built = 0;
    class ProbeSocket extends TeamSocket {
      protected override createWebSocket(): WebSocketSubject<any> {
        built++;
        return new Subject<any>() as unknown as WebSocketSubject<any>;
      }
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TeamSocket, useClass: ProbeSocket },
        { provide: ConfigService, useValue: { api: 'http://api.example.com' } },
      ],
    });

    const socket = TestBed.inject(TeamSocket);

    // Construction alone must open nothing. If it did, Angular DI would decide
    // when the transport starts, and `init()`'s dispose → reset → seed → open
    // ordering would be a comment rather than a guarantee.
    expect(built).toBe(0);
    expect((socket as any)._inbound$.observers.length).toBe(0);
    expect((socket as any)._frames$.observers.length).toBe(0);
    expect((socket as any)._status$.observers.length).toBe(0);
  });

  it('lets a synchronous construction failure PROPAGATE to the caller', () => {
    const { socket } = setup();
    (socket as any).createWebSocket = () => {
      throw new Error('bad ws url');
    };

    // Swallowing it here would leave the orchestrator with no way to flip the
    // spinner off, and the UI would wait for ever on a socket that never existed.
    expect(() => socket.start('proc-1')).toThrowError('bad ws url');
  });

  it('stop() is safe before any start() (a never-opened WS throws on unsubscribe)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        TeamSocket,
        { provide: ConfigService, useValue: { api: 'http://api.example.com' } },
      ],
    });
    const socket = TestBed.inject(TeamSocket);

    expect(() => socket.stop()).not.toThrow();
    expect(() => socket.stop()).not.toThrow();
  });

  it('stop() closes the socket but keeps the streams alive for the next cycle', () => {
    const { socket } = setup();
    let unsubscribed = 0;
    const streamA = new Subject<any>();
    (socket as any).createWebSocket = () =>
      ({
        subscribe: (observer: any) => streamA.subscribe(observer),
        unsubscribe: () => unsubscribed++,
      }) as unknown as WebSocketSubject<any>;

    socket.start('proc-A');
    socket.stop();
    expect(unsubscribed).toBe(1);

    // The subjects must NOT be completed per cycle: a second cycle still has to
    // deliver. Completing them in `stop()` would leave every consumer attached
    // to a dead stream after the first team switch, with nothing failing.
    const streamB = new Subject<any>();
    (socket as any).createWebSocket = () =>
      streamB as unknown as WebSocketSubject<any>;
    const seen: AkgenticMessage[] = [];
    socket.inbound$.subscribe((m) => seen.push(m));
    socket.start('proc-B');
    streamB.next(mkFrame('b-1'));

    expect(seen.map((m: any) => m.id)).toEqual(['b-1']);
  });

  it('destroy() closes the socket FIRST, then completes the three streams', () => {
    const { socket } = setup();
    const stream = new Subject<any>();
    let closed = 0;
    // A double that behaves like a real WebSocketSubject: unsubscribe closes the
    // socket, and the close completes the stream.
    (socket as any).createWebSocket = () =>
      ({
        subscribe: (observer: any) => stream.subscribe(observer),
        unsubscribe: () => {
          closed++;
          stream.complete();
        },
      }) as unknown as WebSocketSubject<any>;
    const seen: TeamSocketStatus[] = [];
    socket.status$.subscribe((s) => seen.push(s));

    socket.start('proc-1');
    socket.destroy();

    // The socket WAS closed, and its close completed the transport stream — but
    // `stop()` detached this unit's observer first, so that completion reaches
    // nobody. A deliberate teardown is not a lost connection: no `complete` is
    // reported on `status$`. Drop the detach and this reads `['complete']`.
    expect(closed).toBe(1);
    expect(seen).toEqual([]);

    // All three streams are finished: a subscriber attaching afterwards is
    // completed immediately rather than left waiting on a dead socket.
    let completed = 0;
    socket.inbound$.subscribe({ complete: () => completed++ });
    socket.frames$.subscribe({ complete: () => completed++ });
    socket.status$.subscribe({ complete: () => completed++ });
    expect(completed).toBe(3);
  });
});

describe("TeamSocket — a stale socket's close never reaches status$ (#405)", () => {
  beforeEach(() => {
    jasmine.clock().install();
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  /** Start A on the async double, stop it, start B on a plain subject. */
  function switchSockets(ending: 'complete' | 'error'): {
    socket: TeamSocket;
    a: ReturnType<typeof asyncClosingSocket>;
    b: Subject<any>;
    seen: TeamSocketStatus[];
  } {
    const { socket } = setup();
    const a = asyncClosingSocket(ending);
    (socket as any).createWebSocket = () => a.socket;
    const seen: TeamSocketStatus[] = [];
    socket.status$.subscribe((s) => seen.push(s));

    socket.start('proc-A');
    socket.stop();

    const b = new Subject<any>();
    (socket as any).createWebSocket = () =>
      b as unknown as WebSocketSubject<any>;
    socket.start('proc-B');
    return { socket, a, b, seen };
  }

  it('drops a stale `complete` delivered after the next start()', () => {
    const { a, b, seen } = switchSockets('complete');
    expect(a.unsubscribed()).toBe(1);

    // A's close lands NOW, with B already started and `status$` subscribed —
    // the sequence a browser produces and no synchronous double can.
    jasmine.clock().tick(0);
    expect(seen).toEqual([]);

    // The stream is not deaf: the CURRENT socket's own ending is reported.
    b.complete();
    expect(seen).toEqual(['complete']);
  });

  it('drops a stale `error` delivered after the next start()', () => {
    spyOn(console, 'error');
    const { b, seen } = switchSockets('error');

    jasmine.clock().tick(0);
    expect(seen).toEqual([]);

    b.error(new Error('lost'));
    expect(seen).toEqual(['error']);
  });

  it('drops the stale close when no new start() has run in between', () => {
    for (const ending of ['complete', 'error'] as const) {
      const { socket } = setup();
      const a = asyncClosingSocket(ending);
      (socket as any).createWebSocket = () => a.socket;
      const seen: TeamSocketStatus[] = [];
      socket.status$.subscribe((s) => seen.push(s));

      socket.start('proc-A');
      socket.stop();
      jasmine.clock().tick(0);

      expect(seen).withContext(ending).toEqual([]);
    }
  });

  it('drops a stale FRAME too: a stopped socket reaches none of the streams', () => {
    const { a, b, socket } = switchSockets('complete');
    const inbound: string[] = [];
    let frames = 0;
    socket.inbound$.subscribe((m: any) => inbound.push(m.id));
    socket.frames$.subscribe(() => frames++);

    a.stream.next(mkFrame('stale'));
    b.next(mkFrame('live'));

    expect(inbound).toEqual(['live']);
    expect(frames).toBe(1);
  });
});

describe('TeamSocket — component-scoped, never root-provided (Story 34-6)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // `ConfigService` is root-provided and therefore always reachable, so a
      // failure here can only mean `TeamSocket` itself is unreachable. Give the
      // class `providedIn: 'root'` and this injection SUCCEEDS instead — one
      // socket shared across every team switch, which is the transport half of
      // the race ADR-005 §Decision 6 closes.
      providers: [],
    });

    expect(() => TestBed.inject(TeamSocket)).toThrowError(/No provider/);
  });
});
