import { useEffect, useState } from "react";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type * as THREE from "three";

const ROOM_URL = "/scene/room.glb";

// 展示ブースの部屋（机・椅子・観葉植物、簡易ジオメトリ）。
// Avatar.tsxの徘徊ロジック(WANDER_BOUNDS/WANDER_OBSTACLES)がこの部屋の実測レイアウトに
// 依存しているため、部屋を差し替える場合はAvatar.tsx側の定数も合わせて調整すること。
export function Room() {
  const [scene, setScene] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let alive = true;
    new GLTFLoader().load(
      ROOM_URL,
      (gltf) => { if (alive) setScene(gltf.scene); },
      undefined,
      (e) => console.error("room.glb load error:", e)
    );
    return () => { alive = false; };
  }, []);

  if (!scene) return null;
  return <primitive object={scene} />;
}
