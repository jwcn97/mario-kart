/**
 * A WebSocket connection that looks after itself:
 *  - reconnects with backoff (0.25 s, 0.5 s, 1 s, 2 s, then every 4 s)
 *  - sends your "hello" message (host or join) every time it (re)connects
 *  - pings once a second to measure round-trip time (`conn.rtt`, smoothed, ms)
 *  - notices a dead connection (no pong for 3.5 s) and replaces it
 *
 * Phones are hard on connections: locking the screen or switching apps can
 * leave a socket that looks open but is dead. The ping check catches that.
 *
 * Used by the game screen and the controller. Works in Node too (tests pass in
 * the `ws` library's WebSocket), so there are no DOM APIs in here.
 */

const BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const OPEN = 1;

export function createConnection({
  url,
  hello = () => null,
  onMessage = () => {},
  onStatus = () => {},
  WebSocketImpl = globalThis.WebSocket,
  pingEveryMs = 1000,
  staleAfterMs = 3500,
  connectTimeoutMs = 4000,
  now = () => performance.now(),
}) {
  let socket = null;
  let status = 'idle';
  let attempt = 0;
  let stopped = false;
  let lastPongAt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let connectTimer = null;

  const conn = {
    /** Smoothed round-trip time to the server in ms, or null before the first pong. */
    rtt: null,
    get status() {
      return status; // 'connecting' | 'connected' | 'reconnecting' | 'stopped'
    },
    get connected() {
      return status === 'connected';
    },
    send,
    stop,
    reconnectNow,
    retry,
  };

  function setStatus(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function open() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (stopped) return;
    setStatus(attempt === 0 && status === 'idle' ? 'connecting' : 'reconnecting');

    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;
    connectTimer = setTimeout(() => drop(ws), connectTimeoutMs);

    ws.onopen = () => {
      if (ws !== socket) return;
      clearTimeout(connectTimer);
      attempt = 0;
      lastPongAt = now();
      setStatus('connected');
      const greeting = hello();
      if (greeting) send(greeting);
      startPinging();
    };

    ws.onmessage = (event) => {
      if (ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        lastPongAt = now();
        const sample = now() - msg.t;
        conn.rtt = conn.rtt === null ? sample : conn.rtt * 0.8 + sample * 0.2;
        return;
      }
      onMessage(msg);
    };

    ws.onclose = () => {
      if (ws === socket) lost();
    };
    ws.onerror = () => {}; // a close event always follows
  }

  /** Forget a socket now, without waiting for its close event (which can take ages on a dead link). */
  function drop(ws) {
    if (ws !== socket) return;
    try {
      ws.close();
    } catch {
      // already closing
    }
    lost();
  }

  function lost() {
    socket = null;
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    if (stopped) setStatus('stopped');
    else scheduleRetry();
  }

  function scheduleRetry() {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    setStatus('reconnecting');
    retryTimer = setTimeout(open, delay);
  }

  function startPinging() {
    clearInterval(pingTimer);
    ping();
    pingTimer = setInterval(ping, pingEveryMs);
  }

  function ping() {
    if (now() - lastPongAt > staleAfterMs) {
      drop(socket); // looks open, but nothing is coming back
      return;
    }
    send({ type: 'ping', t: now() });
  }

  function send(msg) {
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  /** Close for good: no more reconnects (e.g. the room is full or closed). */
  function stop() {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    clearTimeout(connectTimer);
    const ws = socket;
    socket = null;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    setStatus('stopped');
  }

  /**
   * Hang up and try again after `delayMs`. For answers that may change soon,
   * e.g. "no such room" while the game screen is still reconnecting after a server restart.
   */
  function retry(delayMs = 1000) {
    if (stopped) return;
    const ws = socket;
    socket = null; // its late events are ignored from here on
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    clearTimeout(retryTimer);
    try {
      ws?.close();
    } catch {
      // ignore
    }
    setStatus('reconnecting');
    retryTimer = setTimeout(open, delayMs);
  }

  /** Call when the page comes back to the foreground or the network returns. */
  function reconnectNow() {
    if (stopped) return;
    if (socket) {
      // Probably fine, but check right away instead of waiting for the next ping.
      if (socket.readyState === OPEN) ping();
      return;
    }
    attempt = 0;
    open();
  }

  // Start on the next tick, so callers have their `conn` variable before any callback fires.
  queueMicrotask(open);
  return conn;
}
