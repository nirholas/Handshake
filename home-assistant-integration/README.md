# three.ws for Home Assistant

Put a 3D agent with a voice in front of your house, from a Home Assistant that only exists on
your own network.

[three.ws](https://three.ws) can already connect to a Home Assistant that has a remote https
address. Most installs do not have one: they sit on a LAN behind a router, with no port forwarded
and nothing public, and three.ws runs on the internet, so there is no address for it to dial.

This integration is the answer for those. **Your house dials three.ws, and three.ws never dials
your house.**

- Nothing listens on your network. No port is forwarded. No firewall rule changes.
- No tunnel daemon, no third-party service, no other account.
- **three.ws never receives a Home Assistant token.** This integration signs in to Home Assistant
  on your own machine, with a credential it makes for itself, that never leaves the house.

Works on every install type: Home Assistant OS, Supervised, Container and Core.

---

## Install

### Through HACS

1. Open HACS, then the three-dot menu, **Custom repositories**.
2. Add `https://github.com/nirholas/three-ws-home-assistant`, category **Integration**.
3. Install **three.ws**, then restart Home Assistant.
4. **Settings, Devices and services, Add integration, three.ws.**

### By hand

1. Download the latest release.
2. Copy `custom_components/three_ws` into your Home Assistant `config` folder.
3. Restart Home Assistant, then do step 4 above.

## Pair it

1. In three.ws, open [three.ws/smart-home](https://three.ws/smart-home), choose **Connect a home
   that is only on my network**, and press **show me a code**.
2. Paste that code into the integration's setup dialog.

The code works once and lasts ten minutes. If it expires, get another one: it goes back to the
same home, not a second one.

That is the whole setup. The three.ws tab flips to connected on its own within a few seconds.

## What it adds to Home Assistant

One entity, `binary_sensor.three_ws_connection`, so you can see the state of the link from your
own dashboard without opening three.ws:

| Attribute | What |
|---|---|
| `relay_id` | This home's public handle. Not a secret. |
| `open_sessions` | How many connections three.ws currently holds |
| `refused_messages` | How many messages this integration refused as outside the allowlist |
| `last_error` | The last reason the link dropped, if any |

It also creates one system user, **three.ws relay**, visible in Settings, People. That is how it
signs in to your own Home Assistant locally, the same pattern the built-in Supervisor integration
uses. Deleting the integration deletes that user and its credential.

## What three.ws can do through this

Everything it can do is fixed by an allowlist that this integration enforces on your machine,
independently of anything three.ws says. It is shipped as `allowlist.json` inside this
integration, generated from the relay's own source, so the two cannot quietly disagree.

**Permitted:** reading entity states, reading your floor, area, device and entity registries, the
live state subscription, and calling device services.

**Refused outright, and no confirmation anywhere unlocks them:** every service on
`shell_command`, `python_script`, `hassio`, `supervisor`, `backup`, `update`, `cloud`, `config`,
`auth` and `command_line`, plus `homeassistant.restart`, `homeassistant.stop` and the reload
services. Those administer your machine rather than a device, so this integration never runs them
on three.ws's behalf.

There is no path through this integration that lets three.ws pick an arbitrary URL, run arbitrary
code, or reach anything else on your network.

**Unlocking, opening and disarming are permitted, and that is deliberate**, because a smart-home
agent that cannot unlock your door when you ask it to is not a smart-home agent. Every one of them
stops on the three.ws side and waits for a person to approve it explicitly, and every one of them
is written to an audit log there and to your own Home Assistant logbook here.

Read [the threat model](https://github.com/nirholas/three.ws/blob/main/docs/home-relay-threat-model.md)
before you decide. It is specific about what a compromise of three.ws would mean for your house,
and it does not undersell it.

## Remove it

Delete the integration in Home Assistant. Its outbound connection closes and the local credential
it created is deleted. Disconnecting from the three.ws side works too, and takes effect
immediately at both ends.

## Troubleshooting

**"Home Assistant could not reach three.ws"** during pairing: this machine has no outbound
internet access, or something is blocking it. The integration only ever makes outgoing
connections, so nothing needs to be opened inbound.

**"That pairing code is not recognised"**: codes expire in ten minutes and work once. Generate
another in three.ws.

**"This three.ws integration is too old for the relay"**: update it in HACS and restart. The
pairing survives an update; nothing has to be redone.

**The connection sensor is off**: the integration is not dialled in. It retries with backoff and
comes back on its own. `last_error` says why. Nothing needs re-pairing.

## Developing on it

```
custom_components/three_ws/
  __init__.py       setup, the local system credential, teardown
  config_flow.py    pairing, the only place a code is entered
  relay_client.py   the outbound socket, and session multiplexing
  ha_link.py        one authenticated loopback connection to this Home Assistant
  allowlist.py      the allowlist, enforced here, independently of the relay
  allowlist.json    generated from services/home-relay/src/protocol.js
  binary_sensor.py  the connectivity entity
```

The relay side, the protocol and the tests live in the
[three.ws repository](https://github.com/nirholas/three.ws): `services/home-relay/`,
`docs/home-relay.md`, and `tests/home-relay-*.test.js`.

## License

Apache-2.0.
