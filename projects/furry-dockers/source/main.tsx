import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import FurryDockersGame from "./FurryDockersGame";
import "./standalone.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FurryDockersGame />
  </StrictMode>,
);
