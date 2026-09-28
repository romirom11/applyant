// Which live page a running task's browser MCP tools should act on. The MCP endpoint is one
// long-lived server shared by every task; a grant's `taskId` is how a tool call finds its page.
import type { Page } from 'playwright';

export class TaskPages {
  private readonly pages = new Map<number, Page>();

  bind(taskId: number, page: Page): void {
    this.pages.set(taskId, page);
  }

  get(taskId: number | null): Page | null {
    if (taskId === null) return null;
    return this.pages.get(taskId) ?? null;
  }

  unbind(taskId: number): void {
    this.pages.delete(taskId);
  }
}
