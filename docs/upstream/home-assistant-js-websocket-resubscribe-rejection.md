# Upstream report: a flapping connection crashes the process

**Package:** [`home-assistant-js-websocket`](https://github.com/home-assistant/home-assistant-js-websocket)
**Version reproduced against:** 9.6.0
**Severity:** a server holding connections to many Home Assistant instances is
terminated by one of them flapping.
**Status:** written 2026-09-03, ready to file. Worked around in
[`packages/home-bridge/src/bridge.js`](../../packages/home-bridge/src/bridge.js)
(`guardSubscriptions`) so three.ws is safe today.

---

## Summary

`Connection` re-establishes its subscriptions after a reconnect and attaches no
rejection handler to the promise it creates. If the socket drops again while a
resubscribe command is in flight, that command rejects, the rejection is never
observed, and Node terminates the process under its default
`--unhandled-rejections=throw`.

In a browser this is a console error. In a Node server holding one connection per
tenant, **one flapping instance kills every other tenant's connection in the same
process.**

## Where

`dist/connection.js`, in `_setSocket`, on reconnect:

```js
oldSubscriptions.forEach((info) => {
  if ("subscribe" in info && info.subscribe) {
    info.subscribe().then((unsub) => {      // <- no .catch
      info.unsubscribe = unsub;
      info.resolve();
    });
  }
});
```

`info.subscribe` is `() => this.subscribeMessage(callback, subscribeMessage, options)`,
which rejects when the command comes back `success: false` or when the socket
closes with the command outstanding.

A second, smaller instance of the same shape is in `dist/collection.js`:

```js
if (subscribeUpdates) {
  unsubProm = subscribeUpdates(conn, store);   // <- promise, never caught
}
...
if (unsubProm) unsubProm.then((unsub) => { unsub(); });   // <- no .catch either
```

## How it was reproduced

Against a real Home Assistant (`ghcr.io/home-assistant/home-assistant:stable`,
reporting `2026.9.0`) rather than a mock, with a TCP proxy in front of the
container that closes every socket and refuses new ones on command:

1. Open a connection through the proxy and `subscribeEntities`.
2. Cut the proxy, wait 2.5 s, restore it, wait 2.5 s. Repeat.
3. Within about five cycles the process exits with:

```
UnhandledPromiseRejection: ... The promise rejected with the reason "#<Object>".
```

The rejection value is a Home Assistant result frame:

```json
{ "type": "result", "success": false, "error": {} }
```

The harness is [`scripts/home-chaos.mjs`](../../scripts/home-chaos.mjs),
scenario 2. `node --expose-gc scripts/home-chaos.mjs 2` reproduces it with the
workaround removed.

## Suggested fix

Attach a handler in both places. The resubscribe already has an `info.reject`
available, so the failure can be delivered to whoever is awaiting the original
`subscribeMessage` rather than dropped:

```js
info.subscribe().then(
  (unsub) => {
    info.unsubscribe = unsub;
    info.resolve();
  },
  (err) => {
    // A resubscribe that fails during a flap must not become an unhandled
    // rejection. The next `ready` will try again; a consumer awaiting the
    // original subscribe should hear about it in the meantime.
    info.reject?.(err);
  },
);
```

and in `collection.js`:

```js
if (subscribeUpdates) {
  unsubProm = subscribeUpdates(conn, store);
  unsubProm.catch(() => {});   // retried on the next `ready`
}
```

## The workaround, for anyone who finds this before the fix lands

Replace `subscribeMessage` on the connection object. `info.subscribe` resolves
the method off the instance at call time, so this covers the reconnect path as
well as the first subscribe:

```js
const original = connection.subscribeMessage.bind(connection);
connection.subscribeMessage = (callback, message, options) =>
  original(callback, message, options).then(
    (unsubscribe) => unsubscribe,
    (err) => {
      report(err);          // do not swallow it
      return () => {};      // a no-op unsubscribe keeps the library's bookkeeping intact
    },
  );
```

The library retries the same subscription on the next `ready`, so recovery is
unaffected: verified by reconnecting the house afterwards and seeing live state
resume.
