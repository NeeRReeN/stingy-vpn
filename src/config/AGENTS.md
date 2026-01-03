# Configuration and Type Definition Guide

This directory contains common configuration files and type definitions.

## Overview

Manages type definitions, constants, and configurations used throughout the project.

## File Structure

```
src/
└── config/
    └── types.ts        # Common type definitions
```

## Type Definition Principles

- All types are consolidated in `types.ts`
- Interfaces use `PascalCase`
- Type aliases also use `PascalCase`
- Constants use `UPPER_SNAKE_CASE`

## Key Type Definitions

### WireGuard Configuration

```typescript
interface WireGuardConfig {
  serverPublicKey: string;
  serverPrivateKey: string;
  clientPublicKey: string;
  endpoint: string;
  allowedIPs: string[];
}
```

### AWS Resource Configuration

```typescript
interface VpnStackConfig {
  ec2InstanceType: string;
  spotPrice: string;
  region: string;
  vpcId?: string;
}
```

### Cloudflare Configuration

```typescript
interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
  recordId: string;
  domain: string;
}
```

## Environment Variable Type Definitions

```typescript
interface EnvironmentVariables {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_RECORD_ID: string;
  AWS_REGION: string;
}
```

## Best Practices

- Do not use `any` (use `unknown` + type guards)
- Use `?` for optional properties
- Utilize literal types to improve type safety
- Leverage Utility Types (`Partial`, `Required`, `Pick`, `Omit`, etc.)
