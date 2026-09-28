// Minimise / restore the submission window through a CDP session, so the browser used for
// delivery starts out of the way and hand-off can bring it to the front with everything filled.
// `Browser.setWindowBounds` is a browser-level command; Playwright's `newCDPSession(page)`
// still reaches it over the same connection (the page's target is enough to resolve the window).
import type { Page } from 'playwright';

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface WindowBounds {
  windowId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: WindowState;
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

/** A fresh CDP session on `page`'s browser, closed by the caller when it's done with it. */
export async function cdpSession(page: Page): Promise<CdpSession> {
  const context = page.context() as unknown as {
    newCDPSession(page: Page): Promise<CdpSession>;
  };
  return context.newCDPSession(page);
}

async function windowForTarget(
  session: CdpSession,
): Promise<{ windowId: number; bounds: WindowBounds }> {
  const res = (await session.send('Browser.getWindowForTarget')) as {
    windowId: number;
    bounds: Partial<WindowBounds>;
  };
  return {
    windowId: res.windowId,
    bounds: {
      windowId: res.windowId,
      left: res.bounds.left ?? 0,
      top: res.bounds.top ?? 0,
      width: res.bounds.width ?? 1280,
      height: res.bounds.height ?? 900,
      windowState: (res.bounds.windowState as WindowState) ?? 'normal',
    },
  };
}

/** The window's current bounds and state (for tests, and to remember the size before minimising). */
export async function getWindowBounds(page: Page): Promise<WindowBounds> {
  const session = await cdpSession(page);
  try {
    return (await windowForTarget(session)).bounds;
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Minimises the window: out of the way, but the page keeps running (unlike headless). */
export async function minimizeWindow(page: Page): Promise<void> {
  const session = await cdpSession(page);
  try {
    const { windowId } = await windowForTarget(session);
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Restores and raises the window (hand-off: the candidate should see it right away). */
export async function restoreWindow(page: Page): Promise<void> {
  const session = await cdpSession(page);
  try {
    const { windowId } = await windowForTarget(session);
    // A minimised window must go through "normal" before another state sticks (CDP quirk).
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.bringToFront().catch(() => {});
  } finally {
    await session.detach().catch(() => {});
  }
}
