import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WobbleGame from "./WobbleGame";
import "./standalone.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WobbleGame />
  </StrictMode>,
);
