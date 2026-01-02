# AGENTS.md

このファイルは AI コーディングエージェント向けのプロジェクト全体概要を提供します。各サブディレクトリには詳細な AGENTS.md が配置されています。

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

## ディレクトリ構成と詳細ガイド

各ディレクトリには専用の AGENTS.md が配置されており、詳細な情報を提供しています。

```
stingy-vpn/
├── AGENTS.md                   # このファイル（プロジェクト全体概要）
├── README.md
├── .github/
│   └── copilot-instructions.md # GitHub Copilot 向け簡潔な指示
├── src/
│   ├── cdk/                    # AWS CDK スタック
│   │   └── AGENTS.md           # → CDK 開発の詳細ガイド
│   ├── lambda/                 # Lambda 関数
│   │   └── AGENTS.md           # → Lambda 開発の詳細ガイド
│   └── config/                 # 設定関連
│       └── AGENTS.md           # → 型定義・設定の詳細ガイド
└── wireguard/                  # WireGuard 設定
    └── AGENTS.md               # → WireGuard 設定の詳細ガイド
```

**各ディレクトリの AGENTS.md を参照**:

- [src/cdk/AGENTS.md](src/cdk/AGENTS.md) - AWS インフラ定義
- [src/lambda/AGENTS.md](src/lambda/AGENTS.md) - Lambda 関数実装
- [src/config/AGENTS.md](src/config/AGENTS.md) - 型定義・設定
- [wireguard/AGENTS.md](wireguard/AGENTS.md) - VPN 設定

---

## クイックスタート

### セットアップ

```bash
# 依存関係インストール
npm install

# TypeScript ビルド
npm run build

# CDK ブートストラップ（初回のみ）
npx cdk bootstrap

# CDK デプロイ
npx cdk deploy
```

### 開発コマンド

```bash
# TypeScript の変更を監視
npm run watch

# 全テスト実行
npm test

# リント実行
npm run lint

# CDK 差分確認
npx cdk diff
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
- [ ] 必要に応じて README や AGENTS.md を更新
- [ ] CDK diff で意図した変更のみであることを確認

---

## コスト最適化

- **スポットインスタンス**: オンデマンドの最大 90%オフ
- **t4g.nano/micro 推奨**: WireGuard は軽量なので十分
- **Cloudflare 無料プラン**: DDNS には無料枠で対応可能

## 将来の拡張案

- [ ] Terraform への移行検討
- [ ] 複数リージョン対応
- [ ] モニタリング（CloudWatch Alarms）
- [ ] 自動スケーリング対応
