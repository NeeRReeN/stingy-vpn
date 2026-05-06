# WireGuard Configuration Guide

This directory contains WireGuard VPN configuration files and templates.

## Directory Structure

```
wireguard/
├── server/
│   └── wg0.conf                # Server configuration template (committed with placeholders)
└── client/
    ├── home.example.conf       # Home device template (tracked)
    └── mobile.example.conf     # Mobile device template (tracked)
```

The actual server configuration (with real keys) is **never committed**. It is uploaded to Parameter Store as a `SecureString` and fetched by the EC2 instance at startup via User Data.

Client configuration files (`client/*.conf`) are gitignored. Only `.example` templates are tracked.

## Server Configuration Schema (`server/wg0.conf`)

```ini
[Interface]
Address = 10.0.0.5/24        # Server's IP in the VPN network (fixed)
ListenPort = 51820            # WireGuard default port
PrivateKey = <SERVER_PRIVATE_KEY>  # Replaced with actual key before upload to Parameter Store

[Peer]                        # Home device
PublicKey = <HOME_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.6/32

[Peer]                        # Mobile device
PublicKey = <MOBILE_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.7/32
```

IP address assignments:

| Role                     | Address            |
| ------------------------ | ------------------ |
| Server (`wg0` interface) | `10.0.0.5/24`      |
| Home device              | `10.0.0.6/32`      |
| Mobile device            | `10.0.0.7/32`      |
| Additional clients       | `10.0.0.8/32`, ... |

## Client Configuration Schema (`client/*.example.conf`)

```ini
[Interface]
Address = 10.0.0.X/24        # Client's IP in the VPN network
PrivateKey = <YOUR_PRIVATE_KEY>  # Client's own private key — never commit
DNS = 1.1.1.1

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
Endpoint = your-domain.example.com:51820  # Cloudflare DDNS domain
AllowedIPs = 10.0.0.0/24    # Route only VPN subnet through tunnel
PersistentKeepalive = 25     # Required for NAT traversal
```

## Security Constraints

The following must never be committed to the repository:

- Any `PrivateKey` value (server or client)
- Actual client configuration files (`client/*.conf`)

The following are safe to commit:

- `PublicKey` values
- Template files (`*.example.conf`, `server/wg0.conf` with placeholders)

These constraints are enforced by `.gitignore`.
