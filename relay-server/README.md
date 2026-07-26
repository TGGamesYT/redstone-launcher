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
| `RELAY_ADMINS`       | `./admins.json`                                | `{ "uuids": ["<undashed-uuid>", …] }`    |
| `RELAY_STATE`        | `./relay-state.json`                           | Tracks recently-used subdomains.         |

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
