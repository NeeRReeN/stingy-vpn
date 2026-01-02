# 設定・型定義ガイド

このディレクトリには共通の設定ファイルと型定義が含まれます。

## 概要

プロジェクト全体で使用される型定義、定数、設定を管理します。

## ファイル構成

```
config/
└── types.ts            # 共通型定義
```

## 型定義の原則

- すべての型は `types.ts` に集約
- インターフェースは `PascalCase`
- 型エイリアスも `PascalCase`
- 定数は `UPPER_SNAKE_CASE`

## 主要な型定義

### WireGuard 設定

```typescript
interface WireGuardConfig {
  serverPublicKey: string;
  serverPrivateKey: string;
  clientPublicKey: string;
  endpoint: string;
  allowedIPs: string[];
}
```

### AWS リソース設定

```typescript
interface VpnStackConfig {
  ec2InstanceType: string;
  spotPrice: string;
  region: string;
  vpcId?: string;
}
```

### Cloudflare 設定

```typescript
interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
  recordId: string;
  domain: string;
}
```

## 環境変数の型定義

```typescript
interface EnvironmentVariables {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_RECORD_ID: string;
  AWS_REGION: string;
}
```

## ベストプラクティス

- `any` を使用しない（`unknown` + 型ガードを使用）
- オプショナルプロパティは `?` を使用
- リテラル型を活用して型安全性を向上
- Utility Types を活用（`Partial`, `Required`, `Pick`, `Omit` など）
