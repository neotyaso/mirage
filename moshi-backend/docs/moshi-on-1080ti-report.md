# Moshi on GTX 1080 Ti — 動作検証レポート (2026-09-07)

## 結論

1080Ti (CC 6.1, 11GB) ではMoshiフルリアルタイム対話は**不可能**。

## 計測値

| 項目 | 値 |
|------|-----|
| VRAM bf16ロード後 | 11,062 MB / 11,264 MB (余裕 148MB) |
| VRAM 1step後 | 11,116 MB |
| 1step推論時間 | 5,509 ms (目標80msの69倍) |
| Mimi codec | +1,008MB |
| LM (7B Moshiko) | +10,323MB |

## 致命的制約

1. VRAM余裕僅か → Mimi encode/decode + KV cache でOOM
2. 5.5秒/step → リアルタイム対話不能
3. Compute 6.1 → Triton inductor (CC7.0+) が動かない

## 試した対策

- q8モデル: moshi 0.2.13のloaders.get_moshi_lmが`weight_scb`を読まない → 0.2.14+待ち
- NO_TORCH_COMPILE=1: 速度改善せず
- CPU offload: 推論速度が更に悪化

## 採用方針

Lightning AIで開発 → Modal本番運用。
両方ともA10G/L4 (CC 8.x) を使う。