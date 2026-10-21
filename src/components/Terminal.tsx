import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import type { PtyEvent } from "../lib/types";

const THEME = {
  background: "#16171d",
  foreground: "#d8dae3",
  cursor: "#e6e8ef",
  selectionBackground: "#3a3f55",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.06)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.18)",
  black: "#1d1f27",
  red: "#ef6b73",
  green: "#8bd49c",
  yellow: "#e8c46c",
  blue: "#6cb2f0",
  magenta: "#c49bf2",
  cyan: "#66d4d0",
  white: "#d8dae3",
  brightBlack: "#5c6170",
  brightRed: "#ff8a91",
  brightGreen: "#a6e5b4",
  brightYellow: "#f3d78f",
  brightBlue: "#8cc6f7",
  brightMagenta: "#d5b5f7",
  brightCyan: "#8ae3df",
  brightWhite: "#ffffff",
};

interface Props {
  id: string;
  cwd: string;
  command: string | null;
  active: boolean;
  onActivity?: () => void;
  onBell?: () => void;
}

export function Terminal({ id, cwd, command, active, onActivity, onBell }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<{ term: XTerm; fit: FitAddon } | null>(null);
  // Callbacks and translations change identity on every render; read them
  // through refs so the terminal (and its process) is created only once.
  const latest = useRef({ onActivity, onBell, t });
  latest.current = { onActivity, onBell, t };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => void api.openUrl(uri)));
    term.open(container);
    if (container.offsetWidth > 0) fit.fit();
    instanceRef.current = { term, fit };

    let disposed = false;
    let exited = false;
    let lastActivity = 0;

    const spawn = () => {
      const channel = new Channel<PtyEvent>();
      channel.onmessage = (event) => {
        if (disposed) return;
        if (event.kind === "data") {
          term.write(event.data);
          const now = Date.now();
          if (now - lastActivity > 1000) {
            lastActivity = now;
            latest.current.onActivity?.();
          }
        } else {
          exited = true;
          term.write(`\r\n\x1b[2m${latest.current.t("terminal.exited")}\x1b[0m\r\n`);
        }
      };
      exited = false;
      api
        .ptySpawn({ id, cwd, command, cols: term.cols, rows: term.rows }, channel)
        .catch((error: unknown) => term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`));
    };

    term.attachCustomKeyEventHandler((event) => {
      // Shift+Enter inserts a newline in agent prompts (Claude Code, Codex).
      if (event.type === "keydown" && event.key === "Enter" && event.shiftKey && !exited) {
        void api.ptyWrite(id, "\x1b\r");
        return false;
      }
      return true;
    });
    term.onData((data) => {
      if (exited) {
        if (data === "\r") {
          term.reset();
          spawn();
        }
        return;
      }
      api.ptyWrite(id, data).catch(() => undefined);
    });
    term.onResize(({ cols, rows }) => {
      if (!exited) api.ptyResize(id, cols, rows).catch(() => undefined);
    });
    term.onBell(() => latest.current.onBell?.());

    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) fit.fit();
    });
    observer.observe(container);

    spawn();

    return () => {
      disposed = true;
      observer.disconnect();
      api.ptyKill(id).catch(() => undefined);
      term.dispose();
      instanceRef.current = null;
    };
  }, [id, cwd, command]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!active || !instance) return;
    const frame = requestAnimationFrame(() => {
      instance.fit.fit();
      instance.term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <div className="terminal" ref={containerRef} />;
}
