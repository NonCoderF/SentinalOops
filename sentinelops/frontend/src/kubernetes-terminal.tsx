import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export function KubernetesTerminal() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: 'Cascadia Code, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: { background: '#080D15', foreground: '#D7E6F7', cursor: '#2DD4BF', selectionBackground: '#28565E' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(hostRef.current);
    fit.fit();
    terminal.focus();

    // xterm normally handles paste through its hidden textarea. Keep an
    // explicit handler as well because the surrounding dashboard can
    // otherwise intercept Ctrl+V/context-menu paste events.
    const paste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      terminal.paste(text);
      terminal.focus();
    };
    const focus = () => terminal.focus();
    hostRef.current.addEventListener('paste', paste);
    hostRef.current.addEventListener('pointerdown', focus);

    const token = sessionStorage.getItem('sentinelops-admin-token');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/kubernetes/terminal${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    socket.addEventListener('open', () => {
      terminal.writeln('\x1b[36mSentinelOops Kubernetes terminal connected.\x1b[0m');
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      terminal.focus();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type?: string; status?: string };
          if (message.type === 'bridge') return;
        } catch { /* shell output is normally ANSI text */ }
        terminal.write(event.data);
      }
    });
    socket.addEventListener('error', () => terminal.writeln('\r\n\x1b[31mTerminal connection failed.\x1b[0m'));
    socket.addEventListener('close', () => terminal.writeln('\r\n\x1b[33mTerminal disconnected.\x1b[0m'));
    const input = terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
    const resize = () => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); };
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      hostRef.current?.removeEventListener('paste', paste);
      hostRef.current?.removeEventListener('pointerdown', focus);
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, []);

  return <div className="xterm-terminal" ref={hostRef} aria-label="Interactive Kubernetes terminal" />;
}
