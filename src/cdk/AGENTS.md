# CDK スタック開発ガイド

このディレクトリには AWS CDK スタック定義が含まれます。

## 概要

stingy-vpn の AWS インフラストラクチャを定義する CDK スタックです。

## 主要リソース

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

## CDK コマンド

```bash
# CDK スタックの差分確認
npx cdk diff

# CDK デプロイ
npx cdk deploy

# CDK スタック削除
npx cdk destroy

# CloudFormation テンプレート生成
npx cdk synth
```

## スポットインスタンス復旧フロー

1. EventBridge がスポット中断イベントを検知
2. Recovery Lambda が起動
3. 新しいスポットインスタンスをリクエスト
4. S3 から WireGuard 設定を取得・適用
5. Parameter Store のインスタンス ID を更新
6. DDNS Updater Lambda で Cloudflare DNS を更新

## コーディング規約

- CDK Construct は再利用可能なように設計
- `constructs/` ディレクトリに分離可能
- リソース名にはプロジェクト名をプレフィックスとして付与
- タグを適切に設定（コスト管理・リソース識別のため）

## ベストプラクティス

- スポットインスタンスの中断ハンドリングを必ず実装
- IAM ポリシーは最小権限の原則を遵守
- Parameter Store にはセキュアな値のみを保管
- S3 バケットには暗号化を有効化
