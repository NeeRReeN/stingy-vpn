---
applyTo: "**/lambda/**/*.ts"
description: "AWS Lambda 関数開発のベストプラクティス"
---

# Lambda 関数開発ガイドライン

## 基本方針

- Node.js 20.x ランタイム
- ARM64 アーキテクチャ（コスト効率）
- 単一責任: 1 Lambda = 1 機能

## ディレクトリ構造

```
src/lambda/
├── recovery/
│   ├── index.ts        # ハンドラー
│   ├── services/       # ビジネスロジック
│   │   ├── ec2.ts
│   │   └── parameter-store.ts
│   └── __tests__/      # テスト
│       └── index.test.ts
└── ddns-updater/
    ├── index.ts
    ├── services/
    │   └── cloudflare.ts
    └── __tests__/
```

## ハンドラーパターン

### 基本構造

```typescript
import type { EventBridgeEvent, Context } from "aws-lambda";

// 型定義
interface SpotInterruptionDetail {
  "instance-id": string;
  "instance-action": string;
}

type SpotInterruptionEvent = EventBridgeEvent<
  "EC2 Spot Instance Interruption Warning",
  SpotInterruptionDetail
>;

// ハンドラー
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
    throw error; // Lambda に失敗を通知
  }
};
```

### レスポンスパターン（API Gateway 連携時）

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

## 環境変数の取得

```typescript
// ✅ 起動時にバリデーション
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

// モジュールレベルで初期化（コールドスタート時に1回）
const config = loadConfig();
```

## AWS SDK の使用

```typescript
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

// クライアントはモジュールレベルで初期化（再利用）
const ssmClient = new SSMClient({});
const ec2Client = new EC2Client({});

// Parameter Store から値を取得
async function getParameter(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true, // SecureString の場合
  });

  const response = await ssmClient.send(command);

  if (!response.Parameter?.Value) {
    throw new Error(`Parameter not found: ${name}`);
  }

  return response.Parameter.Value;
}

// Parameter Store に値を保存
async function putParameter(name: string, value: string): Promise<void> {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Overwrite: true,
  });

  await ssmClient.send(command);
}
```

## 外部 API 呼び出し

### Cloudflare API 例

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

## リトライ処理

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

// 使用例
const record = await withRetry(() => updateDnsRecord(zoneId, recordId, ip));
```

## ログ出力

```typescript
// ✅ 構造化ログ
console.info("DNS record updated", {
  zoneId,
  recordId,
  oldIp: previousRecord.content,
  newIp: ip,
  ttl: record.ttl,
});

// ✅ エラーログにはコンテキストを含める
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

// ❌ 避ける: シークレットをログに出力
console.log("Using token:", apiToken); // NG!
```

## テスト

```typescript
import { handler } from "../index";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssmMock = mockClient(SSMClient);

describe("Recovery Lambda", () => {
  beforeEach(() => {
    ssmMock.reset();
    // 環境変数をモック
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

const mockContext = {
  awsRequestId: "test-request-id",
  functionName: "test-function",
} as any;
```

## パフォーマンス最適化

```typescript
// ✅ SDK クライアントはモジュールレベルで初期化
const ssmClient = new SSMClient({});

// ✅ 頻繁にアクセスする値はキャッシュ
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
  tokenExpiresAt = now + 5 * 60 * 1000; // 5分キャッシュ

  return cachedToken;
}
```
