/**
 * Debug logging for the mobile terminal pipeline. Prefix: `[dispatch-terminal]`.
 *
 * Enabled when `__DEV__` is true, or set `globalThis.__DISPATCH_TERMINAL_DEBUG__ = true` in a JS
 * debugger / Metro console to trace release/TestFlight builds.
 */
export function isTerminalDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      ((globalThis as { __DISPATCH_TERMINAL_DEBUG__?: boolean }).__DISPATCH_TERMINAL_DEBUG__ ===
        true ||
        (globalThis as { __T3_TERMINAL_DEBUG__?: boolean }).__T3_TERMINAL_DEBUG__ === true))
  );
}

export function terminalDebugLog(message: string, data?: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  if (data !== undefined) {
    console.log(`[dispatch-terminal] ${message}`, data);
  } else {
    console.log(`[dispatch-terminal] ${message}`);
  }
}
