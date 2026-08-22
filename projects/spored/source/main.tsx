import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SporedGame from "./SporedGame";
import "./standalone.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SporedGame />
  </StrictMode>,
);
