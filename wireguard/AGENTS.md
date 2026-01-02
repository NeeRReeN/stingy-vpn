# WireGuard 設定ガイド

このディレクトリには WireGuard VPN の設定ファイルが含まれます。

## 概要

WireGuard はモダンで高速な VPN プロトコルです。このプロジェクトでは、EC2 インスタンスを VPN サーバーとして使用し、自宅機と外出先機を接続します。

## ディレクトリ構成

```
wireguard/
├── server/                 # サーバー設定（S3 にアップロード）
│   └── wg0.conf
├── client/                 # クライアント設定（gitignore対象）
│   ├── .gitkeep
│   ├── home.conf.example       # 自宅機用雛形（追跡対象）
│   └── mobile.conf.example     # 外出先機用雛形（追跡対象）
```

## サーバー設定

### サーバー設定テンプレート（`server/wg0.conf`）

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

### 設定のポイント

- サーバーは `10.0.0.1/24` を使用
- ポート `51820` は WireGuard のデフォルト
- 各クライアントには固有の IP アドレスを割り当て

## クライアント設定

### クライアント設定テンプレート

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

### 設定のポイント

- 各クライアントには異なる IP アドレス（10.0.0.2, 10.0.0.3 など）を使用
- DNS は Cloudflare の 1.1.1.1 を推奨
- `PersistentKeepalive = 25` で NAT 越えを維持

## 鍵の生成

```bash
# 秘密鍵の生成
wg genkey > privatekey

# 公開鍵の生成（秘密鍵から）
wg pubkey < privatekey > publickey
```

## セキュリティ重要事項

### 🔐 絶対にコミットしてはいけないもの

- ❌ **秘密鍵**（`PrivateKey`）
- ❌ **実際のクライアント設定ファイル**（`client/*.conf`、`.example` 以外）

### ✅ コミット可能なもの

- ✅ **公開鍵**（`PublicKey`）
- ✅ **設定の雛形**（`*.conf.example`）
- ✅ **サーバー設定テンプレート**（秘密鍵はプレースホルダー）

## WireGuard 設定の適用

### サーバー側（EC2 インスタンス）

```bash
# WireGuard インストール
sudo apt update
sudo apt install wireguard

# 設定ファイルを配置
sudo cp wg0.conf /etc/wireguard/

# WireGuard を起動
sudo wg-quick up wg0

# 自動起動を有効化
sudo systemctl enable wg-quick@wg0
```

### クライアント側

```bash
# WireGuard インストール（macOS）
brew install wireguard-tools

# 設定ファイルを配置
cp home.conf /usr/local/etc/wireguard/wg0.conf

# WireGuard を起動
wg-quick up wg0

# WireGuard を停止
wg-quick down wg0
```

## トラブルシューティング

### VPN 接続できない

| 問題                 | 原因                 | 解決策                               |
| -------------------- | -------------------- | ------------------------------------ |
| 接続がタイムアウト   | DNS 未更新           | Cloudflare で DNS レコード確認       |
| ハンドシェイクが失敗 | 鍵の不一致           | 公開鍵・秘密鍵のペアを確認           |
| NAT 越えができない   | Keepalive 未設定     | `PersistentKeepalive = 25` を設定    |
| EC2 に接続できない   | セキュリティグループ | ポート 51820/UDP を許可              |
| IP アドレスの競合    | 同じ IP を使用       | 各クライアントに異なる IP を割り当て |

### 接続状態の確認

```bash
# WireGuard のステータス確認
sudo wg show

# ハンドシェイクの確認（最新のハンドシェイク時刻が表示される）
sudo wg show wg0 latest-handshakes

# 転送データ量の確認
sudo wg show wg0 transfer
```

## ベストプラクティス

- 秘密鍵は絶対にコミットしない
- 公開鍵のみ共有可能
- `AllowedIPs` を最小限に（必要な IP 範囲のみ許可）
- 定期的に鍵をローテーション
- クライアント設定は `.example` ファイルをコピーして作成
