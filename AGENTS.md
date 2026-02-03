# AGENTS.md

This file provides a project-wide overview for AI coding agents. Each subdirectory contains a detailed AGENTS.md file.

## Project Overview

**stingy-vpn** is a low-cost VPN solution leveraging AWS EC2 Spot Instances. It uses WireGuard to connect home and mobile devices via EC2, enabling secure communication from anywhere.

### Architecture

```
┌──────────────┐         ┌──────────────────────┐         ┌──────────────┐
│ Home Device  │◄───────►│  EC2 Spot Instance   │◄───────►│Mobile Device │
│  (WireGuard) │  WireGuard   │  (WireGuard Server)  │  WireGuard   │  (WireGuard) │
└──────────────┘         └───────────┬──────────┘         └──────────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │   Cloudflare DDNS    │
                        │  (Fixed URL access)  │
                        └──────────────────────┘
```

### Technology Stack

- **Language**: TypeScript
- **Infrastructure**: AWS CDK
- **Compute**: EC2 Spot Instances, Lambda
- **Storage**: Parameter Store (configuration, secrets, instance ID)
- **VPN**: WireGuard
- **DNS**: Cloudflare DDNS (free tier)

---

## Directory Structure and Detailed Guides

Each directory contains a dedicated AGENTS.md file providing detailed information.

```
stingy-vpn/
├── AGENTS.md                   # This file (project-wide overview)
├── README.md
├── .github/
│   ├── copilot-instructions.md # Concise instructions for GitHub Copilot
│   └── instructions/           # Development best practices
│       ├── aws-cdk.instructions.md
│       ├── lambda.instructions.md
│       └── typescript.instructions.md
├── src/
│   ├── cdk/                    # AWS CDK stacks
│   │   └── AGENTS.md           # → CDK development guide
│   ├── lambda/                 # Lambda functions
│   │   └── AGENTS.md           # → Lambda development guide
│   └── config/                 # Configuration
│       └── AGENTS.md           # → Type definitions and config guide
└── wireguard/                  # WireGuard configuration
    └── AGENTS.md               # → WireGuard setup guide
```

**Refer to AGENTS.md in each directory**:

- [src/cdk/AGENTS.md](src/cdk/AGENTS.md) - AWS infrastructure definitions
- [src/lambda/AGENTS.md](src/lambda/AGENTS.md) - Lambda function implementation
- [src/config/AGENTS.md](src/config/AGENTS.md) - Type definitions and configuration
- [wireguard/AGENTS.md](wireguard/AGENTS.md) - VPN configuration

---

## Quick Start

### Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# CDK bootstrap (first time only)
npx cdk bootstrap

# CDK deploy
npx cdk deploy
```

### Development Commands

```bash
# Watch for TypeScript changes
npm run watch

# Run all tests
npm test

# Run linter
npm run lint

# Check CDK diff
npx cdk diff
```

---

## PR Guidelines

### Title Format

```
[component] Brief description of changes
```

Examples:

- `[cdk] Add EC2 spot instance configuration`
- `[lambda] Implement retry logic for DDNS update`
- `[wireguard] Update server configuration template`

### PR Checklist

- See `.github/PULL_REQUEST_TEMPLATE.md`

---

## Cost Optimization

- **Spot Instances**: Up to 90% off compared to on-demand
- **t4g.nano/micro recommended**: WireGuard is lightweight, so these are sufficient
- **Cloudflare free plan**: Free tier is adequate for DDNS

## Future Enhancements

- [ ] Consider migration to Terraform
- [ ] Multi-region support
- [ ] Monitoring (CloudWatch Alarms)
- [ ] Auto-scaling support
