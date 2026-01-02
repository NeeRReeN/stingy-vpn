# Lambda 関数開発ガイド

このディレクトリには AWS Lambda 関数が含まれます。

## 概要

stingy-vpn の Lambda 関数は以下の 2 つです：

- **recovery**: スポットインスタンス中断時の復旧処理
- **ddns-updater**: Cloudflare DDNS レコードの更新

## ディレクトリ構成

```
lambda/
├── recovery/           # スポットインスタンス復旧処理
│   ├── index.ts        # メインハンドラー
│   └── __tests__/      # テスト
├── ddns-updater/       # Cloudflare DDNS 更新
│   ├── index.ts        # メインハンドラー
│   └── __tests__/      # テスト
```

## Lambda 関数仕様

### recovery 関数

**目的**: EC2 スポットインスタンス中断時に新しいインスタンスを起動し、設定を復元

**トリガー**: EventBridge (EC2 Spot Instance Interruption Warning)

**処理フロー**:

1. 中断イベントを受信
2. 新しいスポットインスタンスをリクエスト
3. S3 から WireGuard 設定を取得
4. 新インスタンスに設定を適用
5. Parameter Store のインスタンス ID を更新

**環境変数**:

- `S3_BUCKET`: WireGuard 設定を保管する S3 バケット名
- `PARAMETER_STORE_NAME`: インスタンス ID を保管する Parameter Store 名

### ddns-updater 関数

**目的**: EC2 インスタンスの IP アドレスが変わった際に Cloudflare DNS レコードを更新

**トリガー**: EventBridge (EC2 State Change) または Lambda 直接呼び出し

**処理フロー**:

1. 新しいインスタンスの Public IP を取得
2. Cloudflare API を使用して DNS レコードを更新

**環境変数**:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API トークン（Parameter Store から取得）
- `CLOUDFLARE_ZONE_ID`: Cloudflare Zone ID
- `CLOUDFLARE_RECORD_ID`: 更新対象の DNS レコード ID

## Cloudflare API

### エンドポイント

```
PATCH https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}
```

### 必要な情報

- Zone ID: Cloudflare ダッシュボードから取得
- Record ID: 既存の A レコードの ID
- API Token: DNS 編集権限を持つトークン

## テスト

```bash
# 特定の Lambda 関数のテスト実行
npm test -- --testPathPattern=recovery
npm test -- --testPathPattern=ddns-updater
```

### テスト規約

- テストファイルは `__tests__/` ディレクトリに配置
- ファイル名は `*.test.ts` または `*.spec.ts`
- 環境変数のモックを適切に設定
- AWS SDK の呼び出しをモック化

## エラーハンドリング

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

## ベストプラクティス

- Lambda 関数はステートレスに保つ
- タイムアウト値は処理時間 + バッファを考慮
- リトライロジックを実装（冪等性を確保）
- 構造化ログを使用（JSON 形式）
- メモリ使用量を最適化（コスト削減）
