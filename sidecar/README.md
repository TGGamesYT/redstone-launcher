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
npm run sidecar        # for the machine you are on
```

That is all a developer needs. It leaves the binary in
`sidecar/quiclime/target/release/`, which is where `backend/e4mc.js` looks when
the launcher is run from a checkout, so e4mc works immediately afterwards with
no packaging step.

It also copies it to `sidecar/dist/<platform>-<arch>/` and to
`sidecar/dist/current/`. The second is what electron-builder packages.

Other ways in:

```sh
npm run sidecar:all                         # every target this machine can link
npm run sidecar -- --mac-both               # both macOS architectures
npm run sidecar -- --target=win32-x64       # one in particular
SKIP_SIDECAR=1 npm run buildLinux           # package without it
```

`npm run sidecar:all` is expected to fail most targets on any one machine --
there is no Windows linker on a Mac -- so it reports what it managed and
carries on. Asking for ONE target and not getting it is an error.

And the tests, which stand up an actual quiclime relay and run the binary
against it:

```sh
cd sidecar/quiclime && cargo test --release
```

### Packaging

`npm run buildWin`, `buildLinux` and `buildMac` each build the sidecar first,
through an npm `pre` step. Since every release job runs on its own operating
system, that is how a release ends up with a binary for each platform without
anybody cross-compiling: the Windows job builds the Windows one, and so on.

electron-builder ships `sidecar/dist/current/` as the app's
`resources/sidecar/`, which is the first place `backend/e4mc.js` looks. One
fixed path rather than a `${platform}-${arch}` macro, because the build script
has already put the right binary there and a path that cannot be
misinterpreted cannot ship the wrong binary.

If Rust is missing the build stops and says so, rather than quietly producing
an installer with no e4mc support. `SKIP_SIDECAR=1` is the way past that when
it is actually wanted -- a copy without the sidecar still shares worlds, since
the relay setting's default is "whichever works" and falls back to the
launcher's own relay.

`.github/workflows/sidecar.yml` additionally builds and tests all four targets
on every change to the crate, and uploads them as artifacts.

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
