# AGENTS.md

## プロジェクト概要

**stingy-vpn** は、AWS EC2 スポットインスタンスを活用した低コスト VPN ソリューションです。WireGuard を使用して自宅機と外出先機を EC2 経由で接続し、どこからでもセキュアな通信を実現します。

### アーキテクチャ

```
┌──────────────┐         ┌──────────────────────┐         ┌──────────────┐
│   自宅機     │◄───────►│  EC2 Spot Instance   │◄───────►│   外出先機   │
│  (WireGuard) │  WireGuard   │  (WireGuard Server)  │  WireGuard   │  (WireGuard) │
└──────────────┘         └───────────┬──────────┘         └──────────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │   Cloudflare DDNS    │
                        │  (固定URLでアクセス)   │
                        └──────────────────────┘
```

### 主要技術スタック

- **言語**: TypeScript
- **インフラ**: AWS CDK
- **コンピュート**: EC2 スポットインスタンス、Lambda
- **ストレージ**: S3（設定ファイル）、Parameter Store（インスタンス ID）
- **VPN**: WireGuard
- **DNS**: Cloudflare DDNS（無料）

---

## ディレクトリ構成

```
stingy-vpn/
├── AGENTS.md
├── README.md
├── package.json
├── tsconfig.json
├── cdk.json
├── src/
│   ├── cdk/                    # AWS CDK スタック
│   │   ├── stingy-vpn-stack.ts
│   │   └── constructs/
│   ├── lambda/                 # Lambda 関数
│   │   ├── recovery/           # スポットインスタンス復旧処理
│   │   │   └── index.ts
│   │   └── ddns-updater/       # Cloudflare DDNS 更新
│   │       └── index.ts
│   └── config/                 # 設定関連
│       └── types.ts
├── wireguard/
│   ├── server/                 # サーバー設定（S3 にアップロード）
│   │   └── wg0.conf
│   └── client/                 # クライアント設定（gitignore対象）
│       ├── .gitkeep
│       ├── home.conf.example       # 自宅機用雛形（追跡対象）
│       └── mobile.conf.example     # 外出先機用雛形（追跡対象）
└── scripts/                    # ユーティリティスクリプト
```

---

## セットアップコマンド

```bash
# 依存関係インストール
npm install

# TypeScript ビルド
npm run build

# CDK ブートストラップ（初回のみ）
npx cdk bootstrap

# CDK デプロイ
npx cdk deploy

# CDK 差分確認
npx cdk diff
```

---

## 開発ワークフロー

### ローカル開発

```bash
# TypeScript の変更を監視してビルド
npm run watch

# Lambda 関数のローカルテスト（SAM CLI 使用時）
sam local invoke RecoveryFunction --event events/spot-interruption.json
```

### 環境変数

開発時は `.env` ファイルを使用（`.gitignore` 対象）:

```env
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ZONE_ID=your_zone_id
CLOUDFLARE_RECORD_ID=your_record_id
AWS_REGION=ap-northeast-1
```

---

## テスト

```bash
# 全テスト実行
npm test

# 特定のテストファイルを実行
npm test -- --testPathPattern=recovery

# カバレッジレポート生成
npm run test:coverage
```

### テスト規約

- テストファイルは `*.test.ts` または `*.spec.ts` の命名規則
- Lambda 関数のテストは `src/lambda/**/__tests__/` に配置
- CDK スナップショットテストを活用

---

## コードスタイル

### TypeScript 規約

- **strict モード**: `tsconfig.json` で strict: true を使用
- **型定義**: any の使用を禁止、明示的な型定義を推奨
- **非同期処理**: async/await を使用（コールバック地獄を避ける）
- **エラーハンドリング**: try-catch で適切にエラーを処理

### 命名規則

| 種類                | 規則             | 例                |
| ------------------- | ---------------- | ----------------- |
| ファイル名          | kebab-case       | `ddns-updater.ts` |
| クラス              | PascalCase       | `StingyVpnStack`  |
| 関数/変数           | camelCase        | `updateDnsRecord` |
| 定数                | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 型/インターフェース | PascalCase       | `WireGuardConfig` |

### ESLint / Prettier

```bash
# Lint 実行
npm run lint

# Lint 自動修正
npm run lint:fix

# フォーマット
npm run format
```

---

## セキュリティガイドライン

### 🔐 シークレット管理

- **絶対にハードコードしない**: API キー、トークン、秘密鍵
- **AWS Systems Manager Parameter Store を使用**: インスタンス ID、Cloudflare API トークン
- **環境変数**: Lambda 関数では環境変数経由でシークレットを取得

```typescript
// ✅ 正しい例
const token = process.env.CLOUDFLARE_API_TOKEN;

// ❌ 間違った例
const token = "cf_xxxxxxxxxxxxx"; // 絶対にNG
```

### 🔒 WireGuard 設定

- **秘密鍵は絶対にコミットしない**: クライアント設定の秘密鍵
- **公開鍵のみ共有可能**: サーバー/クライアント間の公開鍵交換
- **AllowedIPs を最小限に**: 必要な IP 範囲のみ許可

### 🛡️ AWS IAM

- **最小権限の原則**: Lambda 関数には必要最小限の権限のみ付与
- **リソースベースポリシー**: 可能な限り特定リソースに限定

---

## AWS リソース

### デプロイされるリソース

| リソース                 | 用途                              |
| ------------------------ | --------------------------------- |
| EC2 スポットインスタンス | WireGuard サーバー                |
| Lambda (Recovery)        | スポット中断時の復旧処理          |
| Lambda (DDNS Updater)    | Cloudflare DNS レコード更新       |
| S3 バケット              | WireGuard サーバー設定保管        |
| Parameter Store          | インスタンス ID、API トークン保管 |
| EventBridge              | スポット中断イベント検知          |
| IAM ロール               | Lambda 実行権限                   |

### スポットインスタンス復旧フロー

1. EventBridge がスポット中断イベントを検知
2. Recovery Lambda が起動
3. 新しいスポットインスタンスをリクエスト
4. S3 から WireGuard 設定を取得・適用
5. Parameter Store のインスタンス ID を更新
6. DDNS Updater Lambda で Cloudflare DNS を更新

---

## Cloudflare DDNS 連携

### 必要な情報

- Zone ID: Cloudflare ダッシュボードから取得
- Record ID: 既存の A レコードの ID
- API Token: DNS 編集権限を持つトークン

### API エンドポイント

```
PATCH https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}
```

---

## WireGuard 設定

### サーバー設定テンプレート（`wireguard/server/wg0.conf`）

```ini
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <SERVER_PRIVATE_KEY>  # Parameter Store から取得

# 自宅機
[Peer]
PublicKey = <HOME_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.2/32

# 外出先機
[Peer]
PublicKey = <MOBILE_DEVICE_PUBLIC_KEY>
AllowedIPs = 10.0.0.3/32
```

### クライアント設定テンプレート（雛形）

```ini
[Interface]
Address = 10.0.0.X/24
PrivateKey = <YOUR_PRIVATE_KEY>  # ローカルで生成、コミット禁止
DNS = 1.1.1.1

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
Endpoint = your-domain.example.com:51820
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
```

---

## トラブルシューティング

### よくある問題

| 問題                       | 原因                     | 解決策                         |
| -------------------------- | ------------------------ | ------------------------------ |
| VPN 接続できない           | DNS 未更新               | Cloudflare で DNS レコード確認 |
| Lambda タイムアウト        | 処理時間超過             | タイムアウト値を増加           |
| CDK デプロイ失敗           | IAM 権限不足             | CloudFormation エラーログ確認  |
| スポット中断後に復旧しない | EventBridge ルール未設定 | イベントパターン確認           |

### ログ確認

```bash
# Lambda ログ確認
aws logs tail /aws/lambda/StingyVpn-RecoveryFunction --follow

# EC2 インスタンスの状態確認
aws ec2 describe-instances --filters "Name=tag:Name,Values=stingy-vpn"
```

---

## PR ガイドライン

### タイトル形式

```
[component] 変更内容の簡潔な説明
```

例:

- `[cdk] EC2 スポットインスタンスの設定追加`
- `[lambda] DDNS 更新処理のリトライロジック実装`
- `[wireguard] サーバー設定テンプレート更新`

### PR チェックリスト

- [ ] `npm run lint` がパス
- [ ] `npm test` がパス
- [ ] 機密情報（秘密鍵、トークン）が含まれていないことを確認
- [ ] 必要に応じて README を更新
- [ ] CDK diff で意図した変更のみであることを確認

---

## 追加メモ

### コスト最適化

- **スポットインスタンス**: オンデマンドの最大 90%オフ
- **t4g.nano/micro 推奨**: WireGuard は軽量なので十分
- **Cloudflare 無料プラン**: DDNS には無料枠で対応可能

### 将来の拡張案

- [ ] Terraform への移行検討
- [ ] 複数リージョン対応
- [ ] モニタリング（CloudWatch Alarms）
- [ ] 自動スケーリング対応
