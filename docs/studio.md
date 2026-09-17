# Mirage Studio — 学習方針と開発計画

## 目的

展示PC上で自律動作する AI キャラクター「Mirage」の状態を、ブラウザから観測・管理する Web アプリ。
**最重要方針: 完成することより、私（開発者）がコードの意味を説明でき、自分で実装できるようになること。**
AI は講師・ペアプログラマー。コードの丸投げはしない。

## 学習ルール（必ず守る）

**基本スタイル: 「動かして見る → 動いたコードを材料に理解する」が先。概念の先行説明・確認問題はやらない。**

1. 概念を先に大量に説明しない。まず小さなコードを書いて動かす
2. 動いたあと、そのコードを見ながら一つずつ理解する（tsx とは？ useState とは？など）
3. 自分で書ける部分は完成コードを提示せず、ヒントと方針のみ → 自分で書く
4. 書いたコードはレビューする（良い点 / 問題点 / なぜ問題か）
5. エラー時はすぐ修正版を出さず、原因を自分で考察できるようヒントを出す
6. 「実装して」と明示されたときだけコードを提示する（提示時も重要部分を解説）
7. 一度に大量のコードを出さない。小さな単位で進める
8. コピーだけで進んでいる状態になったら、実装を止めて考えさせる
9. 「次」と言われても勝手に大量実装せず、次に学ぶ内容を提示する

## 学習対象と進め方

HTML・CSSは理解している前提とし、基礎説明は省く。
Studioを小さく動かしながら、React・TypeScript・Next.js・Gitを一緒に学ぶ。各技術を別々に座学で終えてから実装する進め方にはしない。

- React: 状態（useState）、イベント、コンポーネント、props、必要になった段階でuseEffect
- TypeScript: 型推論、リテラル型・ユニオン型、propsやAPIデータの型。実際に型エラーを見て役割を理解する
- Next.js: page.tsx、App Router、Client / Server Components、API。触った機能から理解する
- Git: 実際の変更を材料に、差分確認・ステージング・コミット・履歴・ブランチを学ぶ

学習パス: 画面を作る → useStateとボタン → 状態の型を限定する → コンポーネントとprops → APIと必要なuseEffect → WebSocket → Mirageの状態を取得

### Gitの学び方

- まず `git status` で変更されたファイルを確認し、`git diff` で変更内容を読む。未追跡ファイルの内容は通常の `git diff` には出ない
- 小さな変更が動いた区切りで、対象ファイルだけを `git add` し、`git diff --staged` で記録する内容を確認する
- `git commit` で変更を履歴に残し、`git log` で振り返る。コミットとリモートへ送る `git push` の違いも実際の操作で学ぶ
- ブランチ・マージ・コンフリクト解消は必要になった段階で扱う
- 自分で実行できる操作は自分で行う。変更を伴うコマンドは、何が変わるかを実行前に短く説明する
- AIは明示的な依頼なしにコミット・pushを実行しない。秘密情報はステージング・コミットしない

## 何を作るか（MVP の完成ライン）

> 「Mirage が今何をしているのかを、ブラウザから見られる」

- Login（まずは簡易認証でよい。Auth.js 等への置き換えは後）
- Dashboard: Mirage の状態 / 現在の Interaction 状態（Zone, Phase, Attention, Conversation, Action）
- Session List / Session Detail（Interaction Timeline）

後回し（この順で育てる）: 設定変更 → DB 本格化 → Analytics → 遠隔操作 → 複数 Mirage → AWS

## 構成

- Mirage 本体 = このリポジトリ（Vite + React + Three.js、展示PC）
- Mirage Studio = 別の Next.js アプリ。このリポジトリの `studio/` に置く（別リポジトリに split するかは後で判断）
- Mirage → Studio: WebSocket で状態・イベントを送信（Studio 死亡時も本体は自律動作継続が大前提）
- Studio → Mirage: 将来的に設定変更・操作命令（MVP では受信のみ）

## 技術スタック（仮。実装の都度、その都度説明して決める）

- Next.js（App Router）/ React / TypeScript / Tailwind
- DB: PostgreSQL + ORM（Drizzle or Prisma）— **セッション保存を実装する段まで DB は作らない**
- 認証: MVP 初期は簡易（環境変数 + Basic 認証想定）

<!-- ponytail: 簡易認証。複数管理者・権限管理が要る段階で Auth.js に置き換え -->

## 進め方（ステップ）

1. `studio/` にNext.jsの最小プロジェクトを作り、pnpmで起動する
2. useStateとボタンで表示を切り替え、そのコードでReactとTypeScriptを学ぶ
3. コンポーネント分割とpropsを試す
4. APIで練習用の状態データを取得する
5. 必要な本体コードを読み、WebSocketでMirageの状態を表示する。本体の設計理解を学習開始の前提にしない
6. セッションの保存とSession List / Detail、認証を実装しDashboardとして統合する。未認証の管理画面をインターネットに公開しない
7. 以降: 設定変更 → Analytics → 遠隔操作 → 複数台

各ステップの小さな変更をGit学習の材料にする。

## 現在のステータス

- [x] `studio/` にNext.jsを作成し、pnpmへ移行
- [x] 開発サーバーを起動し、Hello worldの表示を本人が確認
- [x] 本人がuseStateによるOFFLINE → ONLINEの更新を実装
- [x] 本人の依頼でAIがボタンによる双方向切り替えを実装、lint・型チェック成功
- [ ] ブラウザで2回押してOFFLINEに戻ることを本人が確認
- [ ] 次のReact・TypeScript学習: statusをONLINE / OFFLINEだけ許可する型にする
- [ ] 次のGit学習: 現在の変更をstatusとdiffで確認する
