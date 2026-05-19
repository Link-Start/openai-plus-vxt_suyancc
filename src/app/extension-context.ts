export function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /extension context invalidated/i.test(error.message);
}

export function canUseExtensionApi(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}
