# Lambda Function Development Guide

This directory contains AWS Lambda functions.

## Overview

stingy-vpn has the following two Lambda functions:

- **recovery**: Recovery handling during spot instance interruption
- **ddns-updater**: Cloudflare DDNS record updates

## Directory Structure

```
src/
└── lambda/
    ├── recovery/           # Spot instance recovery handling
    │   ├── index.ts        # Main handler
    │   └── __tests__/      # Tests
    └── ddns-updater/       # Cloudflare DDNS updates
        ├── index.ts        # Main handler
        └── __tests__/      # Tests
```

## Lambda Function Specifications

### recovery Function

**Purpose**: Launch a new instance and restore configuration when EC2 spot instance is interrupted

**Trigger**: EventBridge (EC2 Spot Instance Interruption Warning)

**Processing Flow**:

1. Receive interruption event
2. Request a new spot instance
3. Retrieve WireGuard configuration from S3
4. Apply configuration to new instance
5. Update instance ID in Parameter Store

**Environment Variables**:

- `S3_BUCKET`: S3 bucket name storing WireGuard configuration
- `PARAMETER_STORE_NAME`: Parameter Store name storing instance ID

### ddns-updater Function

**Purpose**: Update Cloudflare DNS record when EC2 instance IP address changes

**Trigger**: EventBridge (EC2 State Change) or direct Lambda invocation

**Processing Flow**:

1. Get Public IP of the new instance
2. Update DNS record using Cloudflare API

**Environment Variables**:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token (retrieved from Parameter Store)
- `CLOUDFLARE_ZONE_ID`: Cloudflare Zone ID
- `CLOUDFLARE_RECORD_ID`: DNS record ID to update

## Cloudflare API

### Endpoint

```
PATCH https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}
```

### Required Information

- Zone ID: Obtain from Cloudflare dashboard
- Record ID: ID of existing A record
- API Token: Token with DNS edit permissions

## Testing

```bash
# Run tests for specific Lambda function
npm test -- --testPathPattern=recovery
npm test -- --testPathPattern=ddns-updater
```

### Testing Conventions

- Place test files in `__tests__/` directory
- File names should be `*.test.ts` or `*.spec.ts`
- Properly set up environment variable mocks
- Mock AWS SDK calls

## Error Handling

```typescript
try {
  const result = await someAsyncOperation();
  return result;
} catch (error) {
  console.error("Operation failed", { error, context: "functionName" });
  throw new Error(
    `Failed: ${error instanceof Error ? error.message : "Unknown error"}`
  );
}
```

## Best Practices

- Keep Lambda functions stateless
- Set timeout values considering processing time + buffer
- Implement retry logic (ensure idempotency)
- Use structured logs (JSON format)
- Optimize memory usage (cost reduction)
