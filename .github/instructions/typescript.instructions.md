---
applyTo: "**/*.ts"
description: "TypeScript 開発のベストプラクティスとコーディング規約"
---

# TypeScript 開発ガイドライン

## 基本方針

- TypeScript 5.x / ES2022 をターゲット
- 純粋な ES Modules を使用（`require`, `module.exports` 禁止）
- 可読性と明示性を重視し、トリッキーな実装を避ける

## 型システム

### 型定義

```typescript
// ✅ 明示的な型定義
interface WireGuardPeer {
  publicKey: string;
  allowedIPs: string[];
  endpoint?: string;
}

// ✅ discriminated union で状態を表現
type OperationResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

// ❌ any の使用禁止
function process(data: any) {} // NG

// ✅ unknown + 型ガード
function process(data: unknown) {
  if (isValidData(data)) {
    // 安全に処理
  }
}
```

### ユーティリティ型の活用

```typescript
// Readonly で不変性を表現
type ReadonlyConfig = Readonly<Config>;

// Partial で部分更新
type ConfigUpdate = Partial<Config>;

// Pick/Omit で必要なプロパティのみ抽出
type PublicConfig = Omit<Config, "secretKey">;
```

## 非同期処理

### async/await パターン

```typescript
// ✅ 推奨: async/await + try-catch
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

// ❌ 避ける: コールバックチェーン
function fetchData(callback: (err: Error | null, data?: Data) => void) {}
```

### 並列処理

```typescript
// ✅ 独立した処理は並列実行
const [users, posts] = await Promise.all([fetchUsers(), fetchPosts()]);

// ✅ エラーを個別にハンドリング
const results = await Promise.allSettled([
  riskyOperation1(),
  riskyOperation2(),
]);
```

## エラーハンドリング

### カスタムエラー

```typescript
// ✅ ドメイン固有のエラークラス
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

// 使用例
throw new CloudflareApiError("DNS update failed", 403, "FORBIDDEN");
```

### ガード節で早期リターン

```typescript
// ✅ 推奨: ガード節
function processRecord(record: Record | null): Result {
  if (!record) {
    throw new Error("Record is required");
  }
  if (!record.isValid) {
    throw new Error("Record is invalid");
  }
  // メイン処理
  return doProcess(record);
}

// ❌ 避ける: 深いネスト
function processRecord(record: Record | null): Result {
  if (record) {
    if (record.isValid) {
      return doProcess(record);
    }
  }
  throw new Error("Invalid");
}
```

## 関数設計

### 単一責任

```typescript
// ✅ 1つの関数は1つの責任
async function updateDnsRecord(ip: string): Promise<void> {
  const record = await fetchCurrentRecord();
  const updated = await patchRecord(record.id, ip);
  await verifyUpdate(updated);
}

// ❌ 避ける: 複数の責任を持つ巨大関数
async function handleEverything() {
  // DNS更新、通知、ログ、クリーンアップ全部入り
}
```

### 純粋関数を優先

```typescript
// ✅ 純粋関数: 同じ入力 → 同じ出力
function calculateAllowedIPs(peers: Peer[]): string[] {
  return peers.map((p) => p.allowedIP);
}

// 副作用がある場合は明示的に
async function saveConfig(config: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config));
}
```

## インポート/エクスポート

```typescript
// ✅ 名前付きエクスポートを優先
export { updateDnsRecord, fetchRecord };
export type { DnsRecord, UpdateOptions };

// ✅ Node.js 組み込みモジュールは node: プレフィックス
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ❌ 避ける: default export の乱用
export default class {} // 名前がないと追跡困難
```

## コメントとドキュメント

````typescript
/**
 * Cloudflare DNS レコードを更新する
 *
 * @param zoneId - Cloudflare Zone ID
 * @param recordId - 更新対象の DNS レコード ID
 * @param ip - 新しい IP アドレス
 * @returns 更新されたレコード
 * @throws {CloudflareApiError} API エラー時
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
  // 実装
}
````
