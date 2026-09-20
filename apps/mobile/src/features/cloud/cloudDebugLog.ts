export function isCloudDebugEnabled(): boolean {
  const debugGlobal = globalThis as {
    __DISPATCH_CLOUD_DEBUG__?: boolean;
    __T3_CLOUD_DEBUG__?: boolean;
  };
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (debugGlobal.__DISPATCH_CLOUD_DEBUG__ ?? debugGlobal.__T3_CLOUD_DEBUG__) === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[dispatch-cloud] ${event}`, data);
  } else {
    console.log(`[dispatch-cloud] ${event}`);
  }
}
