# WireGuard Configuration Guide

This directory contains WireGuard VPN configuration files.

## Overview

WireGuard is a modern, fast VPN protocol. In this project, we use an EC2 instance as the VPN server to connect home and mobile devices.

## Directory Structure

```
wireguard/
├── server/                 # Server configuration (uploaded to S3)
│   └── wg0.conf
├── client/                 # Client configuration (gitignored)
│   ├── .gitkeep
│   ├── home.example.conf       # Home device template (tracked)
│   └── mobile.example.conf     # Mobile device template (tracked)
```

## Server Configuration

### Server Configuration Template (`server/wg0.conf`)

```ini
[Interface]
Address = 10.0.0.5/24
ListenPort = 51820
PrivateKey = <SERVER_PRIVATE_KEY>  # Retrieved from Parameter Store

# Home device
[Peer]
PublicKey = <HOME_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.6/32

# Mobile device
[Peer]
PublicKey = <MOBILE_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.7/32
```

### Configuration Notes

- Server uses `10.0.0.5/24`
- Port `51820` is the WireGuard default
- Each client is assigned a unique IP address

## Client Configuration

### Client Configuration Template

```ini
[Interface]
Address = 10.0.0.X/24
PrivateKey = <YOUR_PRIVATE_KEY>  # Generated locally, never commit
DNS = 1.1.1.1

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
Endpoint = your-domain.example.com:51820
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
```

### Configuration Notes

- Use different IP addresses for each client (10.0.0.2, 10.0.0.3, etc.)
- Cloudflare's 1.1.1.1 is recommended for DNS
- `PersistentKeepalive = 25` maintains NAT traversal

## Key Generation

```bash
# Generate private key
wg genkey > privatekey

# Generate public key (from private key)
wg pubkey < privatekey > publickey
```

## Security Important Notes

### Never Commit These

- **Private keys** (`PrivateKey`)
- **Actual client configuration files** (`client/*.conf`, except `.example`)

### Safe to Commit

- **Public keys** (`PublicKey`)
- **Configuration templates** (`*.example.conf`)
- **Server configuration template** (private key as placeholder)

## Applying WireGuard Configuration

### Server Side (EC2 Instance)

```bash
# Install WireGuard
sudo apt update
sudo apt install wireguard

# Place configuration file
sudo cp wg0.conf /etc/wireguard/

# Start WireGuard
sudo wg-quick up wg0

# Enable auto-start
sudo systemctl enable wg-quick@wg0
```

### Client Side

```bash
# Install WireGuard (macOS)
brew install wireguard-tools

# Place configuration file
cp home.conf /usr/local/etc/wireguard/wg0.conf

# Start WireGuard
wg-quick up wg0

# Stop WireGuard
wg-quick down wg0
```

## Troubleshooting

### Cannot Connect to VPN

| Issue                 | Cause             | Solution                            |
| --------------------- | ----------------- | ----------------------------------- |
| Connection timeout    | DNS not updated   | Check DNS record in Cloudflare      |
| Handshake fails       | Key mismatch      | Verify public/private key pairs     |
| NAT traversal fails   | Keepalive not set | Set `PersistentKeepalive = 25`      |
| Cannot connect to EC2 | Security group    | Allow port 51820/UDP                |
| IP address conflict   | Same IP used      | Assign different IPs to each client |

### Checking Connection Status

```bash
# Check WireGuard status
sudo wg show

# Check handshakes (shows latest handshake time)
sudo wg show wg0 latest-handshakes

# Check transfer data
sudo wg show wg0 transfer
```

## Best Practices

- Never commit private keys
- Only public keys can be shared
- Keep `AllowedIPs` minimal (only allow necessary IP ranges)
- Rotate keys periodically
- Create client configuration by copying `.example` files
