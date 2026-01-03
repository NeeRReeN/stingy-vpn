---
applyTo: "**/lambda/**/*.ts"
description: "AWS Lambda function development best practices"
---

# Lambda Function Development Guidelines

## Core Principles

- Node.js 20.x runtime
- ARM64 architecture (cost efficiency)
- Single responsibility: 1 Lambda = 1 function

## Directory Structure

```
src/lambda/
├── recovery/
│   ├── index.ts        # Handler
│   ├── services/       # Business logic
│   │   ├── ec2.ts
│   │   └── parameter-store.ts
│   └── __tests__/      # Tests
│       └── index.test.ts
└── ddns-updater/
    ├── index.ts
    ├── services/
    │   └── cloudflare.ts
    └── __tests__/
```

## Handler Patterns

### Basic Structure

```typescript
import type { EventBridgeEvent, Context } from "aws-lambda";

// Type definitions
interface SpotInterruptionDetail {
  "instance-id": string;
  "instance-action": string;
}

type SpotInterruptionEvent = EventBridgeEvent<
  "EC2 Spot Instance Interruption Warning",
  SpotInterruptionDetail
>;

// Handler
export const handler = async (
  event: SpotInterruptionEvent,
  context: Context
): Promise<void> => {
  console.info("Event received", {
    requestId: context.awsRequestId,
    instanceId: event.detail["instance-id"],
  });

  try {
    await processSpotInterruption(event.detail);
    console.info("Processing completed successfully");
  } catch (error) {
    console.error("Processing failed", { error });
    throw error; // Notify Lambda of failure
  }
};
```

### Response Pattern (API Gateway Integration)

```typescript
import type { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const result = await processRequest(event);
    return createResponse(200, result);
  } catch (error) {
    console.error("Request failed", { error });
    return createResponse(500, { error: "Internal server error" });
  }
};

function createResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}
```

## Environment Variable Retrieval

```typescript
// Validate at startup
interface EnvConfig {
  parameterStorePrefix: string;
  cloudflareZoneId: string;
  cloudflareRecordId: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function loadConfig(): EnvConfig {
  const parameterStorePrefix = process.env.PARAMETER_STORE_PREFIX;
  const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID;
  const cloudflareRecordId = process.env.CLOUDFLARE_RECORD_ID;
  const logLevel = process.env.LOG_LEVEL ?? "info";

  if (!parameterStorePrefix || !cloudflareZoneId || !cloudflareRecordId) {
    throw new Error("Missing required environment variables");
  }

  return {
    parameterStorePrefix,
    cloudflareZoneId,
    cloudflareRecordId,
    logLevel: logLevel as EnvConfig["logLevel"],
  };
}

// Initialize at module level (once during cold start)
const config = loadConfig();
```

## AWS SDK Usage

```typescript
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

// Initialize clients at module level (reuse)
const ssmClient = new SSMClient({});
const ec2Client = new EC2Client({});

// Get value from Parameter Store
async function getParameter(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true, // For SecureString
  });

  const response = await ssmClient.send(command);

  if (!response.Parameter?.Value) {
    throw new Error(`Parameter not found: ${name}`);
  }

  return response.Parameter.Value;
}

// Save value to Parameter Store
async function putParameter(name: string, value: string): Promise<void> {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Overwrite: true,
  });

  await ssmClient.send(command);
}
```

## External API Calls

### Cloudflare API Example

```typescript
interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
}

async function updateDnsRecord(
  zoneId: string,
  recordId: string,
  ip: string
): Promise<DnsRecord> {
  const apiToken = await getParameter(
    `${config.parameterStorePrefix}/cloudflare-token`
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: ip,
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Cloudflare API error: ${response.status} - ${errorBody}`);
  }

  const data: CloudflareResponse<DnsRecord> = await response.json();

  if (!data.success) {
    throw new Error(`Cloudflare API failed: ${JSON.stringify(data.errors)}`);
  }

  return data.result;
}
```

## Retry Processing

```typescript
interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  }
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === options.maxAttempts) {
        break;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        options.maxDelayMs
      );

      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Usage example
const record = await withRetry(() => updateDnsRecord(zoneId, recordId, ip));
```

## Log Output

```typescript
// Structured logging
console.info("DNS record updated", {
  zoneId,
  recordId,
  oldIp: previousRecord.content,
  newIp: ip,
  ttl: record.ttl,
});

// Include context in error logs
console.error("Failed to update DNS record", {
  error:
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : error,
  zoneId,
  recordId,
});

// Avoid: logging secrets
console.log("Using token:", apiToken); // NG!
```

## Testing

```typescript
import { handler } from "../index";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmMock = mockClient(SSMClient);

describe("Recovery Lambda", () => {
  beforeEach(() => {
    ssmMock.reset();
    // Mock environment variables
    process.env.PARAMETER_STORE_PREFIX = "/stingy-vpn/test";
  });

  it("should process spot interruption event", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "test-token" },
    });

    const event = createMockEvent({
      "instance-id": "i-1234567890abcdef0",
    });

    await expect(handler(event, mockContext)).resolves.not.toThrow();
  });
});

function createMockEvent(detail: Record<string, string>) {
  return {
    version: "0",
    id: "test-id",
    "detail-type": "EC2 Spot Instance Interruption Warning",
    source: "aws.ec2",
    time: new Date().toISOString(),
    region: "ap-northeast-1",
    detail,
  };
}

const mockContext: Pick<Context, "awsRequestId" | "functionName"> = {
  awsRequestId: "test-request-id",
  functionName: "test-function",
};
```

## Performance Optimization

```typescript
// Initialize SDK clients at module level
const ssmClient = new SSMClient({});

// Cache frequently accessed values
let cachedToken: string | undefined;
let tokenExpiresAt: number = 0;

async function getCloudflareToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  cachedToken = await getParameter(
    `${config.parameterStorePrefix}/cloudflare-token`
  );
  tokenExpiresAt = now + 5 * 60 * 1000; // Cache for 5 minutes

  return cachedToken;
}
```
