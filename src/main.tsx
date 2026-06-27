import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// StrictMode はあえて使わない:
// dev で effect が2回走るとカメラ/MediaPipe が二重初期化されて不安定になるため。
createRoot(document.getElementById("root")!).render(<App />);
