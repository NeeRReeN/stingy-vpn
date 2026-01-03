# CDK Stack Development Guide

This directory contains AWS CDK stack definitions.

## Overview

CDK stacks that define the AWS infrastructure for stingy-vpn.

## Key Resources

### Deployed Resources

| Resource              | Purpose                                    |
| --------------------- | ------------------------------------------ |
| EC2 Spot Instance     | WireGuard server                           |
| Lambda (Recovery)     | Recovery handling during spot interruption |
| Lambda (DDNS Updater) | Cloudflare DNS record updates              |
| S3 Bucket             | WireGuard server configuration storage     |
| Parameter Store       | Instance ID, API token storage             |
| EventBridge           | Spot interruption event detection          |
| IAM Roles             | Lambda execution permissions               |

## CDK Commands

```bash
# Check CDK stack diff
npx cdk diff

# CDK deploy
npx cdk deploy

# CDK stack destroy
npx cdk destroy

# Generate CloudFormation template
npx cdk synth
```

## Spot Instance Recovery Flow

1. EventBridge detects spot interruption event
2. Recovery Lambda is triggered
3. Request a new spot instance
4. Retrieve and apply WireGuard configuration from S3
5. Update instance ID in Parameter Store
6. DDNS Updater Lambda updates Cloudflare DNS

## Coding Conventions

- Design CDK Constructs to be reusable
- Can be separated into `constructs/` directory
- Prefix resource names with project name
- Set appropriate tags (for cost management and resource identification)

## Best Practices

- Always implement spot instance interruption handling
- Follow the principle of least privilege for IAM policies
- Store only secure values in Parameter Store
- Enable encryption for S3 buckets
