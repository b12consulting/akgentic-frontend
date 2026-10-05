import { Subject } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';

/**
 * A socket whose close lands on a LATER task, as a browser's `onclose` does:
 * under `jasmine.clock()` it arrives on the next `tick`. `subscribe` returns the
 * stream's own `Subscription` — what `TeamSocket.stop()` detaches (#405).
 */
export function asyncClosingSocket(ending: 'complete' | 'error' = 'complete'): {
  socket: WebSocketSubject<any>;
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
  return { socket, unsubscribed: () => count };
}
