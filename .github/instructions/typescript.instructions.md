---
applyTo: "**/*.ts"
description: "TypeScript development best practices and coding conventions"
---

# TypeScript Development Guidelines

## Core Principles

- Target TypeScript 5.x / ES2022
- Use pure ES Modules (`require`, `module.exports` are prohibited)
- Prioritize readability and explicitness; avoid tricky implementations

## Type System

### Type Definitions

```typescript
// Explicit type definitions
interface WireGuardPeer {
  publicKey: string;
  allowedIPs: string[];
  endpoint?: string;
}

// Use discriminated unions to represent state
type OperationResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

// Do not use `any`
function process(data: any) {} // NG

// Use `unknown` + type guards
function process(data: unknown) {
  if (isValidData(data)) {
    // Process safely
  }
}
```

### Utilizing Utility Types

```typescript
// Express immutability with Readonly
type ReadonlyConfig = Readonly<Config>;

// Use Partial for partial updates
type ConfigUpdate = Partial<Config>;

// Extract only necessary properties with Pick/Omit
type PublicConfig = Omit<Config, "secretKey">;
```

## Asynchronous Processing

### async/await Pattern

```typescript
// Recommended: async/await + try-catch
async function fetchData(): Promise<Data> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Fetch failed", { error });
    throw error;
  }
}

// Avoid: callback chains
function fetchData(callback: (err: Error | null, data?: Data) => void) {}
```

### Parallel Processing

```typescript
// Run independent operations in parallel
const [users, posts] = await Promise.all([fetchUsers(), fetchPosts()]);

// Handle errors individually
const results = await Promise.allSettled([
  riskyOperation1(),
  riskyOperation2(),
]);
```

## Error Handling

### Custom Errors

```typescript
// Domain-specific error class
class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

// Usage example
throw new CloudflareApiError("DNS update failed", 403, "FORBIDDEN");
```

### Early Return with Guard Clauses

```typescript
// Recommended: guard clauses
function processRecord(record: Record | null): Result {
  if (!record) {
    throw new Error("Record is required");
  }
  if (!record.isValid) {
    throw new Error("Record is invalid");
  }
  // Main processing
  return doProcess(record);
}

// Avoid: deep nesting
function processRecord(record: Record | null): Result {
  if (record) {
    if (record.isValid) {
      return doProcess(record);
    }
  }
  throw new Error("Invalid");
}
```

## Function Design

### Single Responsibility

```typescript
// One function = one responsibility
async function updateDnsRecord(ip: string): Promise<void> {
  const record = await fetchCurrentRecord();
  const updated = await patchRecord(record.id, ip);
  await verifyUpdate(updated);
}

// Avoid: giant functions with multiple responsibilities
async function handleEverything() {
  // DNS update, notification, logging, cleanup all in one
}
```

### Prefer Pure Functions

```typescript
// Pure function: same input → same output
function calculateAllowedIPs(peers: Peer[]): string[] {
  return peers.map((p) => p.allowedIP);
}

// Make side effects explicit
async function saveConfig(config: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config));
}
```

## Imports/Exports

```typescript
// Prefer named exports
export { updateDnsRecord, fetchRecord };
export type { DnsRecord, UpdateOptions };

// Use node: prefix for Node.js built-in modules
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Avoid: overuse of default exports
export default class {} // Hard to track without a name
```

## Comments and Documentation

````typescript
/**
 * Update a Cloudflare DNS record
 *
 * @param zoneId - Cloudflare Zone ID
 * @param recordId - DNS record ID to update
 * @param ip - New IP address
 * @returns Updated record
 * @throws {CloudflareApiError} On API error
 *
 * @example
 * ```ts
 * const record = await updateDnsRecord('zone123', 'rec456', '203.0.113.1');
 * ```
 */
export async function updateDnsRecord(
  zoneId: string,
  recordId: string,
  ip: string
): Promise<DnsRecord> {
  // Implementation
}
````
