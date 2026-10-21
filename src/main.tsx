import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";

// No StrictMode: its double-mount in dev would spawn every agent twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
