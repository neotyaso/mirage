import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import type { MutableRefObject } from "react";
import type { HandResults } from "../hooks/useHandTracking";
import { usePhoneScreen } from "../hooks/usePhoneScreen";

// Phone dimensions (world units)
const PW = 1.6;
const PH = 3.3;
const PD = 0.08;
const SW = PW - 0.05; // screen width
const SH = PH - 0.05; // screen height

const PINCH_THRESHOLD = 0.06;

// ─── Hand Cursor ──────────────────────────────────────────────────

function HandCursor({
  posRef,
}: {
  posRef: MutableRefObject<THREE.Vector3>;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const dotRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const p = posRef.current;
    ringRef.current?.position.copy(p);
    dotRef.current?.position.copy(p);
  });

  return (
    <>
      <mesh ref={ringRef}>
        <torusGeometry args={[0.07, 0.009, 8, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
      </mesh>
      <mesh ref={dotRef}>
        <sphereGeometry args={[0.018, 8, 8]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </>
  );
}

// ─── Scene ────────────────────────────────────────────────────────

export interface SceneProps {
  resultsRef: MutableRefObject<HandResults>;
}

export function Scene({ resultsRef }: SceneProps) {
  const { viewport } = useThree();
  const phoneRef = useRef<THREE.Group>(null);
  const elapsed = useRef(0);
  const cursorPos = useRef(new THREE.Vector3(0, -30, 1));

  const phoneScreen = usePhoneScreen();
  const hitResultRef = useRef(-1);
  const pinchWasActive = useRef(false);

  useFrame((_, delta) => {
    elapsed.current += delta;

    // Entry animation + float
    if (phoneRef.current) {
      const t = Math.min(elapsed.current * 2.2, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      phoneRef.current.scale.setScalar(eased);
      if (elapsed.current > 0.45) {
        phoneRef.current.position.y =
          Math.sin(elapsed.current * 0.75) * 0.055;
      }
    }

    const results = resultsRef.current;
    if (!results?.landmarks?.length) {
      cursorPos.current.y = -30;
      if (hitResultRef.current !== -1) {
        hitResultRef.current = -1;
        phoneScreen.setHover(-1);
      }
      return;
    }

    const hand = results.landmarks[0];
    const tip = hand[8]; // index finger tip

    // Mirror x, then map to world space
    const nx = 1 - tip.x;
    const wx = (nx - 0.5) * viewport.width;
    const wy = (0.5 - tip.y) * viewport.height;
    cursorPos.current.set(wx, wy, 1);

    // UV coordinates on phone screen (account for float offset)
    const phoneY = phoneRef.current?.position.y ?? 0;
    const u = (wx + SW / 2) / SW;
    const v = (SH / 2 - (wy - phoneY)) / SH;
    const onScreen = u >= 0 && u <= 1 && v >= 0 && v <= 1;

    // Hover hit-test
    const newHit = onScreen ? phoneScreen.hitTest(u, v) : -1;
    if (newHit !== hitResultRef.current) {
      hitResultRef.current = newHit;
      phoneScreen.setHover(newHit);
    }

    // Pinch detection
    const thumb = hand[4];
    const index = hand[8];
    const pinched =
      Math.hypot(thumb.x - index.x, thumb.y - index.y) < PINCH_THRESHOLD;

    // Tap on leading edge of pinch
    if (pinched && !pinchWasActive.current && onScreen) {
      phoneScreen.tap(u, v);
    }
    pinchWasActive.current = pinched;
  });

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.5} />
      <pointLight position={[3, 4, 4]} intensity={2.5} color="#ffffff" />
      <pointLight position={[-3, -2, 3]} intensity={1.0} color="#4455ff" />
      <pointLight position={[0, 0, 6]} intensity={0.4} />

      {/* Phone */}
      <group ref={phoneRef} scale={0}>
        {/* Body */}
        <RoundedBox args={[PW, PH, PD]} radius={0.13} smoothness={4}>
          <meshStandardMaterial
            color="#0d0d1a"
            metalness={0.8}
            roughness={0.1}
          />
        </RoundedBox>

        {/* Screen — canvas texture */}
        <mesh position={[0, 0, PD / 2 + 0.001]}>
          <planeGeometry args={[SW, SH]} />
          <meshBasicMaterial map={phoneScreen.texture} />
        </mesh>

        {/* Camera notch */}
        <mesh
          position={[0, PH / 2 - 0.1, PD / 2 + 0.002]}
          rotation={[0, 0, Math.PI / 2]}
        >
          <capsuleGeometry args={[0.012, 0.055, 4, 8]} />
          <meshBasicMaterial color="#000000" />
        </mesh>

        {/* Home indicator */}
        <mesh
          position={[0, -PH / 2 + 0.13, PD / 2 + 0.002]}
          rotation={[0, 0, Math.PI / 2]}
        >
          <capsuleGeometry args={[0.011, 0.24, 4, 8]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.22} />
        </mesh>
      </group>

      {/* Finger cursor */}
      <HandCursor posRef={cursorPos} />
    </>
  );
}
