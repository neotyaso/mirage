# Modalデプロイ手順

## 前提
- Modalアカウント (https://modal.com)
- ローカルに Python 3.11+

## デプロイ手順

### 1. Modal CLIをインストール
```bash
pip install modal
```

### 2. 認証トークンを取得
```bash
modal token new
```
ブラウザが開くので、Modalアカウントでログイン。

### 3. デプロイ実行
```bash
cd moshi-backend
modal deploy cloud/modal_app.py
```

### 4. デプロイURL確認
```bash
modal app list
```
出力例:
```
moshi-local-realtime  https://<workspace>--moshi-local-realtime-serve.modal.run
```
WebSocketエンドポイントは末尾に `/ws` を付けたもの:
```
wss://<workspace>--moshi-local-realtime-serve.modal.run/ws
```

### 5. ローカルからテスト接続
```bash
MODAL_WS_URL=wss://<workspace>--moshi-local-realtime-serve.modal.run/ws \
    python scripts/test_modal_ws.py
```

## GPU切り替え
環境変数 `MODAL_GPU` で指定 (デフォルト: A10G):
```bash
MODAL_GPU=L4 modal deploy cloud/modal_app.py
MODAL_GPU=L40S modal deploy cloud/modal_app.py
MODAL_GPU=A100 modal deploy cloud/modal_app.py
```

| GPU | 料金/h | Moshi 24B推論 | 備考 |
|-----|--------|----------------|------|
| L4  | $0.80  | △ (要量子化) | コスパ最強、ただし遅い |
| A10G| $1.10  | ○ | バランス型、推奨デフォルト |
| L40S| $1.80  | ◎ | 高速、コールドスタート短い |
| A100| $3.00  | ◎ | 最高性能、コスト高 |

## コールドスタート対策
`cloud/modal_app.py` で `scaledown_window=300` (5分) を設定済み。
これで5分間はコンテナがwarm poolに保持され、リクエスト時に即座にレスポンス可能。

## 料金目安 (月間アクティブ10時間想定)
- L4:  $8/月 + アイドル時間課金なし
- A10G: $11/月 + アイドル時間課金なし
- L40S: $18/月

Modalは**コンテナが立ち上がっている間だけ課金**されるため、idle時は自動的にスケールダウンして$0。

## ログ確認
```bash
modal app logs moshi-local-realtime
```

## リファレンス
- [Modal Quillman (公式サンプル)](https://github.com/modal-labs/quillman)
- [Modal ASGI ドキュメント](https://modal.com/docs/guide/webhooks#asgi)
