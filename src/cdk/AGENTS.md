# CDK Stack Development Guide

This directory contains AWS CDK stack definitions.

## Overview

CDK stacks that define the AWS infrastructure for stingy-vpn.

## Directory Structure

```
src/cdk/
├── bin/
│   └── app.ts                          # CDK application entry point
├── lib/
│   ├── stingy-vpn-stack.ts             # Main stack
│   └── constructs/
│       ├── index.ts                    # Re-exports all constructs
│       ├── vpc-construct.ts            # VPC and security groups
│       ├── recovery-lambda-construct.ts    # Spot interruption recovery Lambda
│       └── ddns-updater-lambda-construct.ts # Cloudflare DDNS updater Lambda
└── types.ts                            # Shared types (Environment)
```

## Key Resources

### Deployed Resources

| Resource              | Purpose                                     |
| --------------------- | ------------------------------------------- |
| EC2 Spot Instance     | WireGuard server                            |
| Lambda (Recovery)     | Recovery handling during spot interruption  |
| Lambda (DDNS Updater) | Cloudflare DNS record updates               |
| Parameter Store       | Configuration, secrets, instance ID storage |
| EventBridge           | Spot interruption event detection           |
| IAM Roles             | Lambda execution permissions                |

## Spot Instance Recovery Flow

1. EventBridge detects spot interruption event
2. Recovery Lambda is triggered
3. Request a new spot instance
4. WireGuard configuration is retrieved from Parameter Store via UserData script
5. Update instance ID in Parameter Store
6. DDNS Updater Lambda updates Cloudflare DNS

## Coding Conventions

- Design CDK Constructs to be reusable; place each Construct in the `constructs/` directory under a dedicated file
- Props interfaces use `readonly` properties throughout
