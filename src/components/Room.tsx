import { useEffect, useState } from "react";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type * as THREE from "three";
import { RoomWindow } from "./Window";

const ROOM_URL = "/scene/room.glb";

// 展示ブースの部屋（簡易ジオメトリ）。机・椅子・観葉植物はコード側で除外している(下記参照)。
// Avatar.tsxの徘徊ロジック(WANDER_BOUNDS)がこの部屋の実測レイアウトに
// 依存しているため、部屋を差し替える場合はAvatar.tsx側の定数も合わせて調整すること。
export function Room() {
  const [scene, setScene] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let alive = true;
    new GLTFLoader().load(
      ROOM_URL,
      (gltf) => {
        if (!alive) return;
        // 椅子・テーブル・観葉植物は撤去(FurnitureRoot配下のChair_*/Table_*/Plant_*という命名のノード群)
        const toRemove: THREE.Object3D[] = [];
        gltf.scene.traverse((o) => {
          if (o.name.startsWith("Chair_") || o.name.startsWith("Table_") || o.name.startsWith("Plant_")) toRemove.push(o);
        });
        toRemove.forEach((o) => o.parent?.remove(o));
        setScene(gltf.scene);
      },
      undefined,
      (e) => console.error("room.glb load error:", e)
    );
    return () => { alive = false; };
  }, []);

  return (
    <>
      {scene && <primitive object={scene} />}
      {/* 奥壁の「外が見える窓」（room.glbには入れずThree.jsで直接描く） */}
      <RoomWindow />
    </>
  );
}
