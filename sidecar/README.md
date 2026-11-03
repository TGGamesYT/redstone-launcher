# sidecar

Small programs the launcher runs because Electron cannot do the thing itself.

## quiclime

Talks to [e4mc](https://e4mc.link)'s relays so a world can be shared over the
internet without port forwarding.

It is a separate program rather than part of `backend/` because **Electron
cannot speak QUIC**, and e4mc's relay is raw QUIC with ALPN `quiclime`:

- Node ships QUIC as a *build-time* option (`node_quic`), off in every release
  build, so there is no `node:quic` however many runtime flags are passed.
  Electron 41's bundled Node 24 is such a build.
- Chromium's WebTransport is HTTP/3 and offers only that ALPN, so it will not
  interoperate.

The protocol itself lives in `backend/quiclime.js` (and is tested there, with
no network); this program is the transport, and `backend/e4mc.js` runs it.

### Building

```sh
cd sidecar/quiclime
cargo test --release     # stands up a real quiclime relay and runs the binary against it
cargo build --release
```

`backend/e4mc.js` finds `target/release/quiclime` on its own when running from
a checkout, so nothing else is needed to develop against it.

### Packaging

`package.json` ships whatever is in `sidecar/dist/<platform>-<arch>/` as the
app's `resources/sidecar/`, which is the first place the launcher looks. So a
release build wants, for example:

```
sidecar/dist/win32-x64/quiclime.exe
sidecar/dist/darwin-arm64/quiclime
sidecar/dist/linux-x64/quiclime
```

`.github/workflows/sidecar.yml` builds and tests all of those and uploads them
as artifacts; dropping them into those directories before `npm run buildWin`
(or the equivalent) is what gets them into the installer.

A copy with no sidecar still works: the relay setting's default is "whichever
works", which falls back to the launcher's own relay rather than failing to
share.

### Credit

The protocol is e4mc's. It was written out from the relay's own source
([vgskye/e4mc-quiclime](https://github.com/vgskye/e4mc-quiclime), Apache-2.0 OR
MIT) and the mod's client
([vgskye/e4mc-minecraft-architectury](https://github.com/vgskye/e4mc-minecraft-architectury),
MIT). The code here is not a copy of either.

Their relays are their infrastructure, run for free. The launcher is a guest on
them: it keeps the keepalive they expect, opens one connection per shared
world, and the relay setting lets an admin move everything back onto our own
relay if that is ever the right thing to do.
