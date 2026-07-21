# Redstone Relay

A tiny reverse‑TCP tunnel that lets servers hosted from the **Redstone Launcher**
be joined over the internet **without the host port‑forwarding or enabling UPnP**.

Players just connect their normal Minecraft client to `redstonemc.net:<port>` —
they don't need the launcher or anything else.

## How it works

```
 Player (vanilla MC)                Relay (your VPS)                 Host (launcher)
        │  connect redstonemc.net:PORT   │                                │
        │───────────────────────────────▶│   OPEN stream ─────────────────▶│  dials 127.0.0.1:25565
        │◀──────── piped bytes ─────────▶│◀──────── DATA frames ──────────▶│  (the real MC server)
```

1. The launcher opens **one TLS control connection** to the relay's control port
   and authenticates with a token.
2. The relay picks a **fresh, unique public port** for that host, starts
   listening on it, and tells the launcher the join address `DOMAIN:PORT`.
3. Each player that connects to that public port is multiplexed over the control
   connection; the launcher pipes it to its local Minecraft server.

All launcher↔relay traffic is **TLS‑encrypted** and **token‑authenticated**.

## Requirements

- A VPS with a public IP and Node.js ≥ 18.
- A domain pointing at it (e.g. an `A` record `redstonemc.net → <VPS IP>`).
- A TLS certificate for that domain (Let's Encrypt works great).
- The public port **range** open in the VPS firewall (default `40000–60000`),
  plus the control port (default `47238`).

## Configuration (environment variables)

| Variable              | Default                          | Meaning                                             |
| --------------------- | -------------------------------- | --------------------------------------------------- |
| `RELAY_CONTROL_PORT`  | `47238`                          | TLS control port the launcher connects to.          |
| `RELAY_DOMAIN`        | `redstonemc.net`                 | Domain shown to players in the join address.        |
| `RELAY_PORT_MIN`      | `40000`                          | Low end of the public port range.                   |
| `RELAY_PORT_MAX`      | `60000`                          | High end of the public port range.                  |
| `RELAY_TOKENS`        | *(empty = open)*                 | Comma‑separated accepted tokens. Set to lock down.  |
| `RELAY_TLS_KEY`       | `/etc/letsencrypt/live/<domain>/privkey.pem`   | TLS private key path (certbot default). |
| `RELAY_TLS_CERT`      | `/etc/letsencrypt/live/<domain>/fullchain.pem` | TLS certificate path (certbot default). |
| `RELAY_MAX_HOSTS`     | `200`                            | Max simultaneous hosts.                             |

> The launcher connects to `RELAY_CONTROL_PORT` on `redstonemc.net` and sends the
> token from its settings (`relayToken`). The **public** port each host is given
> is what players actually join — that's the "very unique port" per session.

## Running

```bash
cd relay-server
# point these at your Let's Encrypt files (or any valid cert for the domain)
export RELAY_TLS_KEY=/etc/letsencrypt/live/redstonemc.net/privkey.pem
export RELAY_TLS_CERT=/etc/letsencrypt/live/redstonemc.net/fullchain.pem
export RELAY_TOKENS=some-long-random-secret          # optional but recommended
node relay.js
```

### systemd unit (recommended)

```ini
# /etc/systemd/system/redstone-relay.service
[Unit]
Description=Redstone Relay
After=network.target

[Service]
Environment=RELAY_TLS_KEY=/etc/letsencrypt/live/redstonemc.net/privkey.pem
Environment=RELAY_TLS_CERT=/etc/letsencrypt/live/redstonemc.net/fullchain.pem
Environment=RELAY_TOKENS=some-long-random-secret
WorkingDirectory=/opt/redstone-launcher/relay-server
ExecStart=/usr/bin/node relay.js
Restart=always
User=redstone

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now redstone-relay
sudo journalctl -u redstone-relay -f
```

### Firewall

```bash
sudo ufw allow 47238/tcp            # control
sudo ufw allow 40000:60000/tcp      # public player ports
```

## Security notes

- Traffic between launcher and relay is TLS; set `RELAY_TOKENS` so only your
  launcher(s) can register.
- The relay never sees Minecraft account credentials — it only forwards the game
  protocol bytes between the player and the host's local server.
- The Minecraft protocol itself is what authenticates players to the server
  (online‑mode servers still verify accounts with Mojang as usual).
