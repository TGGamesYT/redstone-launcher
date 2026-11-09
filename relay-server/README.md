# Redstone Relay

Full ICE-style NAT traversal for the **Redstone Launcher**: servers and
LAN-opened worlds become joinable over the internet with **no port forwarding**,
served on a **single public Minecraft port** for every user.

## How it works

- One public MC port (default **25565**) serves everyone. When a client connects,
  the relay reads its Minecraft **handshake**, takes the hostname it used
  (`<sub>.redstonemc.net`), and routes the connection to whichever launcher has
  registered that subdomain over an authenticated TLS control channel.
- Unknown subdomain → the client's server list shows **"This server doesn't
  exist"**. A subdomain used within the last month but not currently live →
  **"Offline"** with a second line of `redstone-launcher.com` and your icon.
- Hosts prove they own a **premium** Minecraft account via Mojang's
  `join`/`hasJoined` challenge, and may only claim `<username>.redstonemc.net`
  or `<name>.<username>.redstonemc.net`. UUIDs listed in `admins.json` may claim
  any subdomain.

Only the **public MC port + the control port** need to be open in UFW — no port
ranges, so it plays nicely with your existing nginx/UFW setup.

## Requirements

- Wildcard DNS: `*.redstonemc.net → <VPS IP>` (you already have this).
- A TLS cert covering the wildcard (for the control channel):
  `sudo certbot certonly --standalone -d redstonemc.net -d '*.redstonemc.net'`
  (wildcard needs the DNS-01 challenge; e.g. `certbot ... --preferred-challenges dns`).
- Node ≥ 18.

## Config (env vars)

| Variable             | Default                                        | Meaning                                  |
| -------------------- | ---------------------------------------------- | ---------------------------------------- |
| `RELAY_MC_PORT`      | `25565`                                        | Public Minecraft port (all users).       |
| `RELAY_CONTROL_PORT` | `47238`                                        | TLS control port the launcher connects to. |
| `RELAY_DOMAIN`       | `redstonemc.net`                               | Base domain.                             |
| `RELAY_TLS_KEY`      | `/etc/letsencrypt/live/<domain>/privkey.pem`   | TLS key (certbot default).               |
| `RELAY_TLS_CERT`     | `/etc/letsencrypt/live/<domain>/fullchain.pem` | TLS cert (certbot default).              |
| `RELAY_OFFLINE_ICON` | `./offline-icon.png`                           | 64×64 PNG shown for offline/missing servers. |
| `RELAY_ADMINS`       | `./admins.json`                                | `{ "uuids": ["<uuid>", …] }` (dashes optional) |
| `RELAY_STATE`        | `./relay-state.json`                           | Tracks recently-used subdomains.         |
| `RELAY_SUGGESTIONS`  | `./relay-suggestions.json`                     | Suggestions people have sent, and who is timed out. |
| `RELAY_CONFIG`       | `./config.json`                                | Everything that is not in the repository — see **Settings** below. |
| `RELAY_ADMIN_PASSWORD_FILE` | `./admin-password.txt`                  | Where the admin password used to live. Read once and moved into `config.json`; nothing needs it after that. |
| `CF_API_TOKEN`       | *(unset = relay-only)*                         | Cloudflare API token with **Zone → DNS → Edit** on every domain you want to offer. The token's zones are what admins may pick from. Can be set in `config.json` instead. |

An environment variable, where it is set, always beats `config.json` — so
nothing already deployed changes behaviour.

### Direct path (recommended — avoids relaying game traffic)

By default the relay tunnels all Minecraft traffic through the VPS, which adds
latency. If you set `CF_API_TOKEN`, then whenever a host's router supports UPnP
the relay points the chosen hostname's **A record straight at the host's public
IP** (TTL 60, DNS-only). Players then connect **directly** to the host — no relay
hop — while the relay tunnel stays registered as a fallback for anyone with
stale/wildcard DNS. When the host stops sharing, the record is removed.

### Admins & multiple domains

Accounts whose (Mojang-verified) UUID is in `admins.json` may claim **any**
subdomain, and may pick **any domain the Cloudflare token controls** (the app
shows them a domain dropdown fetched live from the relay). Non-`redstonemc.net`
domains have no wildcard→VPS record, so they only work via the direct (UPnP) path.
Everyone else is limited to `<username>.redstonemc.net` / `<x>.<username>.redstonemc.net`.

> Admin status is decided **only** from the Mojang `hasJoined` result on the
> relay — never from anything the launcher sends — so a modified client can't
> impersonate an admin UUID.

### Suggestions & the admin panel

Anyone signed in with a Microsoft account can send a suggestion from the
launcher's settings (Mojang's `hasJoined` proves who they are, so every
suggestion has a real person behind it — and that person is shown what
happened to theirs). They land in `relay-suggestions.json`.

To read and answer them, write the **hash** of a password into the password
file — not the password:

```bash
cd relay-server
printf '%s' 'something long and random' | sha256sum | cut -d' ' -f1 > admin-password.txt
chmod 600 admin-password.txt
```

The first time the relay starts and finds that file, it moves the hash into
`config.json` and says so in the log. The old file is left exactly where it is
— deleting the only copy of a password's hash because a migration thinks it
worked is not a trade worth making — but nothing reads it again. After that,
the password is changed from the admin panel's **Relay settings** page.

The relay only ever has to recognise the password, never know it, so there is
no reason for a copy of it to be sitting on the VPS. The comparison is done in
constant time, so a wrong guess takes exactly as long as a right one. With no
password set, the admin panel is simply closed to everybody.

## Settings

`config.json` holds everything about this relay that is not in the repository:
the admin password's hash, the CurseForge token, the Google OAuth client for
Drive syncing, the base domain, and the list of accounts allowed to change any
of it. It is created on first use, is `chmod 600`, and is in `.gitignore`.

It can be edited on the box, and it is re-read when it changes, so an edit
takes effect on a relay that is already running. It can also be edited from
the admin panel, which is the point of it.

**Who may.** The **Relay settings** page is not behind the admin password. The
password is shared with whoever helps run the relay; that page changes the
relay's own credentials, which is not the same trust. It is behind the
*account*: the connection's UUID, as verified by Mojang's `hasJoined` and not
as claimed by the client, must be in `ownerUuids` — which starts as
TGdoesCode alone. Anybody else is not shown the page, and asking for its ops
by name is refused.

`ownerUuids` is a list and the file can be edited over SSH, so signing in with
a different account is one line to undo rather than a wall. It cannot be
emptied from the panel: there would be nobody left who could put somebody back.

**Secrets are write-only.** The panel shows whether a token is set, never what
it is, and setting a new one has never needed reading the old one. A value
that an environment variable is overriding is shown as such, so "I changed it
and nothing happened" is not a mystery.

Then, in the launcher (with **Developer mode** on), open devtools on any page
and type:

```js
viewAdmin("something long and random")
```

**The panel's contents live here, not in the launcher.** The window asks the
relay for its panels and draws whatever comes back, so a new panel is added to
`ADMIN_PANELS` in `relay.js` — launchers that are already installed pick it up
as soon as the relay restarts, with no release. What a panel may say is
documented beside `ADMIN_PANELS`.

Timing somebody out stops the account **and every account that has connected
from the same place**, so an alt does not walk straight round it. Addresses
themselves are never stored — only a salted hash of each one, which is enough
to say "these two accounts came from the same place" and nothing else.

### Offline server icon

Drop your Velocity `server-icon.png` (a 64×64 PNG) in as `offline-icon.png`
(or point `RELAY_OFFLINE_ICON` at it). It's shown in the server list for
offline/unknown addresses and is hot-reloaded when the file changes.

Drop your Velocity `server-icon.png` in as `offline-icon.png` for the placeholder.

## Run

```bash
cd relay-server
node relay.js
# or under systemd (see below)
```

### Firewall (UFW)

```bash
sudo ufw allow 25565/tcp     # public Minecraft
sudo ufw allow 47238/tcp     # launcher control channel
```

### nginx

The relay speaks raw Minecraft + its own TLS control protocol, so it does **not**
sit behind the nginx HTTP vhost — it listens directly on 25565/47238. Leave your
existing `redstonemc.net:443` HTTP router as-is; just open the two TCP ports.

### systemd

```ini
# /etc/systemd/system/redstone-relay.service
[Unit]
Description=Redstone Relay
After=network.target
[Service]
WorkingDirectory=/opt/redstone-launcher/relay-server
ExecStart=/usr/bin/node relay.js
Restart=always
User=redstone
[Install]
WantedBy=multi-user.target
```

## Security notes

- Traffic launcher↔relay is TLS. Subdomain ownership is gated on a live Mojang
  `hasJoined` check, so only the real owner of a premium account can claim their
  username's subdomains.
- The relay only forwards Minecraft protocol bytes; it never sees account
  credentials, and online-mode servers still verify players with Mojang as usual.
