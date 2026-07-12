import * as fs from "fs";
import { hostname } from "os";
import * as path from "path";

export interface SessionLease { sessionId: string; pid: number; host: string; root: string; acquiredAt: string; expiresAt: number; }

/** A workspace-scoped lease preventing two extension hosts from mutating state concurrently. */
export class PrimarySessionLock {
  private readonly sessionId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  constructor(private readonly lockPath: string, private readonly ttlMs = 30_000) {}
  async acquire(): Promise<() => Promise<void>> {
    await fs.promises.mkdir(path.dirname(this.lockPath), { recursive: true });
    const lease: SessionLease = { sessionId: this.sessionId, pid: process.pid, host: hostname(), root: path.resolve(path.dirname(this.lockPath)), acquiredAt: new Date().toISOString(), expiresAt: Date.now() + this.ttlMs };
    try { await fs.promises.writeFile(this.lockPath, JSON.stringify(lease), { flag: "wx" }); }
    catch {
      try { const current = JSON.parse(await fs.promises.readFile(this.lockPath, "utf8")) as SessionLease;
        if (current.expiresAt > Date.now() || current.host !== lease.host || current.root !== lease.root) throw new Error("Another Ensemble session is currently updating task state.");
        // Atomically move the expired lease out of the way. Two contenders
        // cannot both rename the same lock, so takeover is race-safe.
        const stalePath = `${this.lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
        await fs.promises.rename(this.lockPath, stalePath);
        try { await fs.promises.writeFile(this.lockPath, JSON.stringify(lease), { flag: "wx" }); }
        finally { try { await fs.promises.unlink(stalePath); } catch { /* best-effort stale lock cleanup */ } }
      } catch (error) { if (error instanceof Error && error.message.includes("Another Ensemble")) throw error; throw new Error("Unable to acquire Ensemble state lock."); }
    }
    let stopped = false;
    const heartbeat = setInterval(() => {
      if (stopped) return;
      void (async (): Promise<void> => {
        try { const current = JSON.parse(await fs.promises.readFile(this.lockPath, "utf8")) as SessionLease; if (current.sessionId === this.sessionId) { current.expiresAt = Date.now() + this.ttlMs; await fs.promises.writeFile(this.lockPath, JSON.stringify(current)); } } catch { /* lock heartbeat is best-effort */ }
      })();
    }, Math.max(1000, Math.floor(this.ttlMs / 3)));
    return async () => { stopped = true; clearInterval(heartbeat); try { const current = JSON.parse(await fs.promises.readFile(this.lockPath, "utf8")) as SessionLease; if (current.sessionId === this.sessionId) await fs.promises.unlink(this.lockPath); } catch { /* release is best-effort if the lock already moved */ } };
  }

  /** Run a mutation while holding the lease, always releasing it. */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await operation(); } finally { await release(); }
  }
}
