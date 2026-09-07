# Docs TODO

> Last updated: 2026-07-28
> Scope: `docs/` に書かれている未実装・要確認・移行作業を一枚に集約する。

## P0: まず固める

1. `interactionMachine` の小さい回帰チェックを追加する
   - 対象: `src/state/interactionMachine.ts`
   - 根拠: `docs/state-machine.md` の Migration Plan 1
   - 見るケース:
     - `absent` -> `far` -> `mid` で greeting が request される
     - `far` 滞在が fallback delay を超えると初回 greeting が request される
     - 4 秒以上の離脱で conversation end / memory clear effect が出る
     - `LOOK_AWAY_REACTION_FIRED` で `lookAwayStreak` が増え、新規来場者でリセットされる

2. `docs/state-machine.md` の古い絶対パスを直す
   - 現状: `/Users/apple/mirage/...`
   - 修正案: repo 相対の `src/App.tsx`, `src/state/interactionMachine.ts` 表記にする
   - 理由: 現在の作業環境は Windows の `C:\プログラミング\mirage` なので、Mac の一時パスは混乱する

3. 実機検証チェックリストを `docs/runtime.md` 側に寄せる
   - 現状: `NEXT.md` に実機メモ、`docs/runtime.md` に最小回帰チェックが分散
   - 修正案: `docs/runtime.md` に「展示前リハ用チェック」を追加し、`NEXT.md` は日誌寄りにする

## P1: 実装タスクとして進める

1. `App.tsx` の greeting / firstSeen / silentResume / lastPresent を state machine に移す
   - 根拠: `docs/state-machine.md` Migration Plan 3
   - 狙い: 150ms interval と複数 ref に散った来場者ライフサイクルを明示化する

2. callout / conversation start 判定を state-machine effects に寄せる
   - 根拠: `docs/state-machine.md` Migration Plan 4
   - 注意: 重複発話を起こさないよう、effect の idempotency を先に確認する

3. TTS 経路を統合する
   - 対象: `App.tsx` の app-level `speak()` と `useConversation.ts` の conversation TTS
   - 根拠: `docs/architecture.md`, `docs/behavior.md`, `docs/runtime.md` の Known issue
   - 狙い: 呼び込み・会話・見送りの競合、古い音声再生、割り込み規則を一箇所に寄せる

4. operator status / health check を作る
   - 根拠: `docs/runtime.md` Next Operations Work
   - 表示したいもの:
     - Groq / AivisSpeech / local STT / Ollama の状態
     - primary / fallback / unavailable
     - STT, LLM, TTS の利用 provider と latency

5. `.env.example` を追加する
   - 根拠: `docs/runtime.md` Environment Variables
   - 最低限: `GROQ_API_KEY=`

6. package manager を決めて lockfile を整理する
   - 現状: `package-lock.json` と `pnpm-lock.yaml` が両方ある
   - README は `pnpm dev` 寄り
   - どちらで行くか決めた後、不要な lockfile と docs のコマンド表記を揃える

## P2: リファクタ前に守る仕様を明文化する

1. `Avatar.tsx` 分割前の保護条件を増やす
   - 根拠: `docs/architecture.md` の design bottleneck
   - 追加したい観点:
     - `far` で体ごと来場者に向き直らない
     - `mid/near` で自動会話開始する
     - 会話 TTS が stop 後に再生されない
     - brief dropout で新規来場者扱いにならない

2. provider fallback の状態名を統一する
   - 候補: `primary`, `fallback`, `unavailable`, `degraded`
   - 使う場所: runtime guide, operator UI, logs

3. `docs/architecture.md` の Phase 2 境界を実装順に並べ直す
   - 先にやる: `avatar-state-machine`, `audio-runtime`, `operations`
   - 後でやる: `conversation-runtime`, `perception-runtime`
   - 理由: 今の痛みは展示運用・発話競合・来場者状態の分散が大きい

## docs 整備だけで終わるもの

1. `docs/README.md` を作る
   - 役割: `architecture.md`, `behavior.md`, `runtime.md`, `state-machine.md`, `todo.md` の入口

2. 日誌と仕様書の役割を分ける
   - `NEXT.md`: 日付つきの開発記録・判断ログ
   - `docs/*.md`: 現在仕様・運用手順・移行計画

3. `docs/state-machine.md` の Current Wiring を、実装が進むたびに更新する
   - 特に promoted state が増えたら必ず追記する
