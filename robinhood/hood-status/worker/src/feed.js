import WebSocket from 'ws';

/**
 * Persistent sequencer-feed watcher.
 *
 * The Arbitrum-style broadcast feed pushes batches of sequenced messages:
 *   { version: 1, messages: [{ sequenceNumber, message: {...} }] }
 * On Robinhood Chain the sequence number tracks the L2 block height, so
 * (rpcHead - lastSequenceNumber) is a direct lag measurement.
 *
 * Reconnects with exponential backoff. snapshot() is what the probe cycle
 * records every 30s.
 */
export class FeedWatcher {
  constructor(url, { WebSocketImpl = WebSocket, maxBackoffMs = 60_000 } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.maxBackoffMs = maxBackoffMs;
    this.connected = false;
    this.lastError = null;
    this.lastMessageAt = null;
    this.lastSequenceNumber = null;
    this.messageTimes = []; // rolling 60s of message timestamps
    this.stopped = false;
    this.backoffMs = 1000;
    this.ws = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  #connect() {
    if (this.stopped) return;
    const ws = new this.WebSocketImpl(this.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.lastError = null;
      this.backoffMs = 1000;
    });
    ws.on('message', (data) => this.ingest(data.toString(), Date.now()));
    ws.on('error', (err) => {
      this.lastError = err.message;
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.#connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    });
  }

  /** Parse one broadcast frame (public for tests). */
  ingest(text, now = Date.now()) {
    this.lastMessageAt = now;
    this.messageTimes.push(now);
    const cutoff = now - 60_000;
    while (this.messageTimes.length && this.messageTimes[0] < cutoff) {
      this.messageTimes.shift();
    }
    try {
      const frame = JSON.parse(text);
      const msgs = frame?.messages;
      if (Array.isArray(msgs) && msgs.length) {
        const last = msgs[msgs.length - 1];
        if (Number.isFinite(last?.sequenceNumber)) {
          this.lastSequenceNumber = last.sequenceNumber;
        }
      }
    } catch {
      // Non-JSON keepalive frames still count as liveness.
    }
  }

  /**
   * @param {number|null} rpcHead current chain head from the RPC probe
   * @param {boolean} headAdvancing whether the head moved since last cycle
   */
  snapshot(rpcHead, headAdvancing, now = Date.now()) {
    const silenceSec = this.lastMessageAt ? (now - this.lastMessageAt) / 1000 : null;
    const lagBlocks =
      Number.isFinite(rpcHead) && Number.isFinite(this.lastSequenceNumber)
        ? Math.max(0, rpcHead - this.lastSequenceNumber)
        : null;
    return {
      connected: this.connected,
      error: this.lastError,
      silenceSec,
      lagBlocks,
      headAdvancing,
      messagesPerMin: this.messageTimes.length,
      lastSequenceNumber: this.lastSequenceNumber,
    };
  }
}
