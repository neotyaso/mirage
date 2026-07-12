import { EffectComposer, Bloom } from "@react-three/postprocessing";

// ネオン管など明るい部分だけを発光させるポストプロセス
export function Glow() {
  return (
    <EffectComposer>
      <Bloom luminanceThreshold={0.4} luminanceSmoothing={0.9} intensity={0.35} height={300} />
    </EffectComposer>
  );
}
