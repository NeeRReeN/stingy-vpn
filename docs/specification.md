# Stingy VPN - システム仕様書

## プロジェクト概要

### 目的

AWS Spot Instance を活用した低コストな VPN ソリューション「Stingy VPN」の構築。WireGuard プロトコルを使用し、Spot Instance 中断時の自動復旧機能により、高い可用性と低コストを両立する。

### 主要機能

- WireGuard VPN サーバーのホスティング
- Spot Instance 中断時の自動復旧
- Dynamic DNS 自動更新
- 設定の永続化（Parameter Store）
- ログとメトリクスの収集

### 想定ユーザー

- 個人開発者（1-5 ユーザー）
- 小規模チーム（5-10 ユーザー）
- コストを重視する VPN 利用者

## システムアーキテクチャ

### 使用 AWS サービス

| サービス          | 用途                       | 理由                    |
| ----------------- | -------------------------- | ----------------------- |
| EC2 Spot Instance | VPN サーバー               | 最大 90%のコスト削減    |
| Lambda            | 自動復旧・DNS 更新         | サーバーレス・従量課金  |
| EventBridge       | イベント検知・ルーティング | Spot 中断イベントの検知 |
| Parameter Store   | 設定・シークレット管理     | 無料枠あり・暗号化対応  |
| VPC               | ネットワーク分離           | セキュリティ向上        |
| CloudWatch        | ログ・メトリクス           | 運用監視                |

### 外部サービス

| サービス       | 用途                      |
| -------------- | ------------------------- |
| Cloudflare DNS | Dynamic DNS（オプション） |

## 詳細仕様

### EC2 Spot Instance（VPN サーバー）

#### インスタンス仕様

```yaml
Instance Type: t4g.nano
  vCPU: 2
  Memory: 0.5 GB
  Architecture: ARM64
  Network Performance: Up to 5 Gbps

AMI: Amazon Linux 2023 (ARM64)

Storage:
  Root Volume: 8 GB gp3
  IOPS: 3000
  Throughput: 125 MB/s

Spot Configuration:
  Request Type: one-time
  Interruption Behavior: terminate
  Max Price: オンデマンド価格
```

#### ネットワーク設定

```yaml
VPC CIDR: 10.0.0.0/16
Public Subnet: 10.0.1.0/24
Availability Zone: ap-northeast-1a (単一AZ)

Public IP: 自動割り当て
  - Elastic IP推奨（オプション）
  - 再起動時のIP変更を防止

Security Group (Inbound):
  - Protocol: UDP, Port: 51820, Source: 0.0.0.0/0 (WireGuard)
  - Protocol: TCP, Port: 22, Source: <管理IP>/32 (SSH)

Security Group (Outbound):
  - All traffic allowed
```

#### UserData（起動スクリプト）

```bash
#!/bin/bash
set -euo pipefail

# ログ設定
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting WireGuard setup..."

# WireGuardのインストール
dnf install -y wireguard-tools

# Parameter StoreからWireGuard設定を取得
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
PARAM_PREFIX="/stingy-vpn/prod"

aws ssm get-parameter \
  --name "${PARAM_PREFIX}/wireguard-config" \
  --with-decryption \
  --region ${REGION} \
  --query 'Parameter.Value' \
  --output text > /etc/wireguard/wg0.conf

chmod 600 /etc/wireguard/wg0.conf

# WireGuardサービスの起動
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0

# IP転送の有効化
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p

echo "WireGuard setup completed successfully"
```

### Lambda Function: Recovery Handler

#### 基本設定

```yaml
Function Name: stingy-vpn-recovery-handler
Runtime: nodejs20.x
Architecture: arm64
Memory: 256 MB
Timeout: 5 minutes
Reserved Concurrent Executions: 1

Handler: index.handler
```

#### 環境変数

```yaml
PARAMETER_STORE_PREFIX: /stingy-vpn/prod
LAUNCH_TEMPLATE_ID: lt-xxxxxxxxxxxxx
LOG_LEVEL: info
AWS_REGION: ap-northeast-1
```

#### IAM ロール権限

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:DescribeLaunchTemplates"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:PutParameter"],
      "Resource": "arn:aws:ssm:ap-northeast-1:*:parameter/stingy-vpn/prod/*"
    },
    {
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": "arn:aws:lambda:ap-northeast-1:*:function:stingy-vpn-ddns-updater"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:ap-northeast-1:*:log-group:/aws/lambda/stingy-vpn-recovery-handler:*"
    }
  ]
}
```

#### 処理フロー

```
1. Spot中断イベントを受信
   ↓
2. イベントからインスタンスIDを抽出
   ↓
3. Parameter Storeから現在のインスタンスIDを取得
   ↓
4. イベントのインスタンスIDと一致するか確認
   ↓
5. Launch Templateを使用して新しいSpot Instanceをリクエスト
   ↓
6. 起動完了を待機（最大3分）
   ↓
7. Parameter StoreのインスタンスIDを更新
   ↓
8. DDNS Updater Lambdaを非同期で呼び出し
   ↓
9. CloudWatch Logsに完了ログを出力
```

### Lambda Function: DDNS Updater

#### 基本設定

```yaml
Function Name: stingy-vpn-ddns-updater
Runtime: nodejs20.x
Architecture: arm64
Memory: 128 MB
Timeout: 1 minute
Reserved Concurrent Executions: 1
```

#### 環境変数

```yaml
PARAMETER_STORE_PREFIX: /stingy-vpn/prod
CLOUDFLARE_ZONE_ID: <CloudflareゾーンID>
CLOUDFLARE_RECORD_ID: <DNSレコードID>
LOG_LEVEL: info
```

#### IAM ロール権限

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": [
        "arn:aws:ssm:ap-northeast-1:*:parameter/stingy-vpn/prod/instance-id",
        "arn:aws:ssm:ap-northeast-1:*:parameter/stingy-vpn/prod/cloudflare-token"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:ap-northeast-1:*:log-group:/aws/lambda/stingy-vpn-ddns-updater:*"
    }
  ]
}
```

#### 処理フロー

```
1. Parameter Storeから最新のインスタンスIDを取得
   ↓
2. EC2 APIでインスタンスのPublic IPアドレスを取得
   ↓
3. Parameter StoreからCloudflare APIトークンを取得
   ↓
4. Cloudflare API (PATCH /zones/{zone_id}/dns_records/{record_id})を呼び出し
   ↓
5. レスポンスを確認（成功/失敗）
   ↓
6. 失敗時は指数バックオフでリトライ（最大3回）
   ↓
7. 結果をCloudWatch Logsに出力
```

### EventBridge Rule

#### ルール設定

```yaml
Rule Name: stingy-vpn-spot-interruption-rule
Description: Detect EC2 Spot Instance Interruption Warning
State: ENABLED

Event Pattern:
  source:
    - aws.ec2
  detail-type:
    - EC2 Spot Instance Interruption Warning
  detail:
    instance-id:
      - exists: true

Targets:
  - Arn: arn:aws:lambda:ap-northeast-1:*:function:stingy-vpn-recovery-handler
    Id: RecoveryHandlerTarget
    RetryPolicy:
      MaximumRetryAttempts: 0
```

### Parameter Store

#### パラメータ一覧

| パラメータ名                             | タイプ       | 説明                     | 初期値    |
| ---------------------------------------- | ------------ | ------------------------ | --------- |
| `/stingy-vpn/prod/instance-id`           | String       | 現在のインスタンス ID    | `initial` |
| `/stingy-vpn/prod/cloudflare-token`      | SecureString | Cloudflare API トークン  | 手動設定  |
| `/stingy-vpn/prod/wireguard-config`      | SecureString | WireGuard 設定ファイル   | 手動設定  |
| `/stingy-vpn/prod/wireguard-private-key` | SecureString | サーバー秘密鍵           | 手動設定  |
| `/stingy-vpn/prod/client-public-keys`    | StringList   | クライアント公開鍵リスト | 手動設定  |

#### WireGuard 設定例

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <サーバー秘密鍵>

# IP転送とNATの設定
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
# クライアント1
PublicKey = <クライアント1の公開鍵>
AllowedIPs = 10.8.0.2/32

[Peer]
# クライアント2
PublicKey = <クライアント2の公開鍵>
AllowedIPs = 10.8.0.3/32
```

## デプロイ手順

### 前提条件

- AWS CLI 設定済み
- Node.js 20.x 以上
- AWS CDK v2 インストール済み
- WireGuard クライアント設定済み

### 初期セットアップ

```bash
# 1. リポジトリのクローン
git clone https://github.com/NeeRReeN/stingy-vpn.git
cd stingy-vpn

# 2. 依存関係のインストール
npm install

# 3. WireGuard鍵ペアの生成
wg genkey | tee server-private.key | wg pubkey > server-public.key
wg genkey | tee client-private.key | wg pubkey > client-public.key

# 4. Parameter Storeに秘密情報を保存
aws ssm put-parameter \
  --name /stingy-vpn/prod/cloudflare-token \
  --value "your-cloudflare-token" \
  --type SecureString

aws ssm put-parameter \
  --name /stingy-vpn/prod/wireguard-private-key \
  --value "$(cat server-private.key)" \
  --type SecureString

# 5. CDKブートストラップ（初回のみ）
npx cdk bootstrap

# 6. デプロイ前の差分確認
npx cdk diff

# 7. デプロイ実行
npx cdk deploy
```

### WireGuard クライアント設定

```ini
[Interface]
PrivateKey = <クライアント秘密鍵>
Address = 10.8.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <サーバー公開鍵>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

## 運用

### 監視項目

| メトリクス          | 閾値      | アラート   |
| ------------------- | --------- | ---------- |
| Lambda 実行エラー率 | > 5%      | SNS 通知   |
| Spot 中断頻度       | > 3 回/日 | メール通知 |
| DNS 更新失敗        | > 0 回    | SNS 通知   |
| VPN 接続失敗        | > 2 回/時 | 調査       |

### 定期メンテナンス

- **週次**: CloudWatch Logs の確認
- **月次**: コスト分析・インスタンスタイプの見直し
- **四半期**: セキュリティパッチ適用・AMI 更新

### トラブルシューティング

#### VPN に接続できない

```bash
# 1. EC2インスタンスの状態確認
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=stingy-vpn" \
  --query 'Reservations[*].Instances[*].[InstanceId,State.Name,PublicIpAddress]'

# 2. WireGuardサービスの状態確認（SSH接続後）
sudo systemctl status wg-quick@wg0
sudo wg show

# 3. Security Groupの確認
aws ec2 describe-security-groups \
  --filters "Name=tag:Project,Values=stingy-vpn"
```

#### 自動復旧が動作しない

```bash
# 1. EventBridge Ruleの確認
aws events describe-rule --name stingy-vpn-spot-interruption-rule

# 2. Lambda実行ログの確認
aws logs tail /aws/lambda/stingy-vpn-recovery-handler --follow

# 3. Lambda権限の確認
aws lambda get-policy --function-name stingy-vpn-recovery-handler
```

## セキュリティ

### セキュリティ対策

- **暗号化**: WireGuard (ChaCha20-Poly1305)
- **認証**: 公開鍵認証のみ
- **最小権限**: IAM Role で必要最小限の権限
- **秘密管理**: Parameter Store (SecureString)
- **ネットワーク分離**: Security Group で制限

### 定期的なセキュリティレビュー

- [ ] IAM ロールの権限見直し（月次）
- [ ] Security Group ルールの確認（月次）
- [ ] Parameter Store アクセスログの確認（月次）
- [ ] WireGuard クライアント鍵のローテーション（年次）

## コスト見積もり

### 月額コスト（ap-northeast-1）

| リソース          | 単価                | 使用量     | 月額        |
| ----------------- | ------------------- | ---------- | ----------- |
| t4g.nano Spot     | $0.0014/時間        | 730 時間   | $1.02       |
| EBS gp3 8GB       | $0.096/GB/月        | 8GB        | $0.77       |
| Lambda 実行       | $0.0000133334/GB 秒 | 1000 回/月 | $0.01       |
| Parameter Store   | 無料                | -          | $0.00       |
| CloudWatch Logs   | $0.033/GB           | 0.1GB      | $0.00       |
| データ転送（Out） | $0.114/GB           | 10GB       | $1.14       |
| **合計**          | -                   | -          | **約$3/月** |

※Spot Instance 価格は変動するため、実際のコストは異なる場合があります。

## 参考資料

- [WireGuard 公式ドキュメント](https://www.wireguard.com/)
- [AWS Spot Instance](https://aws.amazon.com/ec2/spot/)
- [AWS Lambda](https://aws.amazon.com/lambda/)
- [Cloudflare API](https://api.cloudflare.com/)
