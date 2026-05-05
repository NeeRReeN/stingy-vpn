# stingy-vpn

A low-cost VPN solution using AWS EC2 Spot Instances and WireGuard. For architecture details and development conventions, see [AGENTS.md](AGENTS.md).

---

## Prerequisites

The following tools must be installed on your local machine before getting started:

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) (configured with appropriate credentials)
- [Node.js](https://nodejs.org/) (v20 or later)
- [WireGuard tools](https://www.wireguard.com/install/) (`wg` command)

---

## Initial Deployment

> [!IMPORTANT]
> Complete the steps in sequence. The Parameter Store entries in steps 3–4 must exist before `cdk deploy` launches an EC2 instance.

### Step 1: Generate WireGuard key pairs

Generate a key pair on your local machine for the server and for each client device.

```bash
# Restrict permissions on files created in this shell session (prevents world-readable key files)
umask 077

# Server key pair
wg genkey | tee server_private.key | wg pubkey > server_public.key

# Home device key pair
wg genkey | tee home_private.key | wg pubkey > home_public.key

# Mobile device key pair
wg genkey | tee mobile_private.key | wg pubkey > mobile_public.key
```

> [!WARNING]
> Keep key files only for the duration of this setup. Delete them after the configuration files are complete (see step 6).

### Step 2: Create the server configuration file

Copy the template and fill in the generated keys:

```bash
cp wireguard/server/wg0.conf /tmp/wg0.conf
```

Edit `/tmp/wg0.conf` — replace placeholders with actual values:

| Placeholder                  | Replace with                       |
| ---------------------------- | ---------------------------------- |
| `<SERVER_PRIVATE_KEY>`       | Contents of `server_private.key`   |
| `<HOME_DEVICE_PUBLIC_KEY>`   | Contents of `home_public.key`      |
| `<MOBILE_DEVICE_PUBLIC_KEY>` | Contents of `mobile_public.key`    |

See [wireguard/AGENTS.md](wireguard/AGENTS.md) for a description of each field.

### Step 3: Upload the server configuration to Parameter Store

> [!NOTE]
> Replace `<environment>` with the same value you will pass to `-c environment=` in Step 5 (e.g. `dev` or `prod`). The CDK stack reads from `/stingy-vpn/<environment>/wireguard-config`.

```bash
aws ssm put-parameter \
  --name "/stingy-vpn/<environment>/wireguard-config" \
  --value "$(cat /tmp/wg0.conf)" \
  --type SecureString \
  --region <YOUR_REGION>
```

> [!NOTE]
> Use `--type SecureString` — this parameter contains the server private key.

### Step 4: Upload the Cloudflare API token to Parameter Store

Create a Cloudflare API token with **DNS Edit** permission for your zone, then upload it:

> [!NOTE]
> Use the same `<environment>` value as in Step 3. The CDK stack reads from `/stingy-vpn/<environment>/cloudflare-token`.

```bash
aws ssm put-parameter \
  --name "/stingy-vpn/<environment>/cloudflare-token" \
  --value "<YOUR_CLOUDFLARE_API_TOKEN>" \
  --type SecureString \
  --region <YOUR_REGION>
```

### Step 5: Deploy the CDK stack

```bash
npm install

# First time only
npx cdk bootstrap

npx cdk deploy \
  -c environment=<environment> \
  -c cloudflareZoneId=<YOUR_CLOUDFLARE_ZONE_ID> \
  -c cloudflareRecordId=<YOUR_CLOUDFLARE_RECORD_ID>
```

### Step 6: Set up the client device configuration file

Copy the appropriate example template:

```bash
# Home device
cp wireguard/client/home.example.conf wireguard/client/home.conf

# Mobile device
cp wireguard/client/mobile.example.conf wireguard/client/mobile.conf
```

Edit the copied file — replace placeholders with actual values:

| Placeholder               | Replace with                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `<YOUR_PRIVATE_KEY>`      | Contents of `home_private.key` or `mobile_private.key`          |
| `<SERVER_PUBLIC_KEY>`     | Contents of `server_public.key`                                 |
| `your-domain.example.com` | Your Cloudflare DDNS domain                                     |

Install the configuration on the client device:

```bash
# macOS
sudo mkdir -p /etc/wireguard
sudo cp wireguard/client/home.conf /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
wg-quick up wg0
```

> [!WARNING]
> Delete all `*.key` files from your local machine after placing the configuration. Client `.conf` files are gitignored — do not commit them.

---

## Adding a New Client Device

1. Generate a new client key pair (Step 1 above)
2. Add a new `[Peer]` block to `/tmp/wg0.conf` with the new client's public key and an unused `AllowedIPs` address (e.g. `10.0.0.8/32`)
3. Re-upload `wireguard-config` to Parameter Store (use `--overwrite`):
   ```bash
   aws ssm put-parameter \
     --name "/stingy-vpn/<environment>/wireguard-config" \
     --value "$(cat /tmp/wg0.conf)" \
     --type SecureString \
     --overwrite \
     --region <YOUR_REGION>
   ```
4. The next EC2 instance replacement will automatically pick up the updated configuration. To apply immediately, terminate the current instance — Recovery Lambda will launch a new one.
5. Set up the client device configuration file (Step 6 above)

---

## Verifying the VPN

On the EC2 instance (via AWS Session Manager):

```bash
sudo wg show
```

On a connected client device:

```bash
# Confirm handshake is recent
sudo wg show wg0 latest-handshakes

# Check data transfer
sudo wg show wg0 transfer
```

---

## Troubleshooting

| Symptom             | Likely cause           | Resolution                                         |
| ------------------- | ---------------------- | -------------------------------------------------- |
| Connection timeout  | DDNS not updated       | Check the A record in Cloudflare dashboard         |
| Handshake fails     | Key mismatch           | Verify all public/private key pairs are consistent |
| NAT traversal fails | Keepalive not set      | Ensure `PersistentKeepalive = 25` in client config |
| Cannot reach EC2    | Security group         | Confirm port 51820/UDP is allowed inbound          |
| IP address conflict | Duplicate `AllowedIPs` | Assign a unique address to each client             |

---

## Development

For development commands (build, test, lint, CDK diff), see [AGENTS.md](AGENTS.md#quick-start).
