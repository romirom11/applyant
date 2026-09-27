// One read-only connection in a worker thread (see read-pool.ts). Runs the SQL it is sent
// and posts the rows back. sqlite-vec is loaded here too, so vec0 MATCH works.
import { parentPort, workerData } from 'node:worker_threads';
import { openConnection } from './client.ts';

interface Request {
  id: number;
  sql: string;
  params: unknown[];
}

const port = parentPort;
if (!port) throw new Error('read-worker.ts must run as a worker thread');

const conn = openConnection((workerData as { path: string }).path, true);

port.on('message', (req: Request) => {
  try {
    // Buffers arrive as plain Uint8Arrays after structured cloning; SQLite binds Buffers.
    const params = req.params.map((p) =>
      p instanceof Uint8Array ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p,
    );
    const rows = conn.prepare(req.sql).all(...params);
    port.postMessage({ id: req.id, rows });
  } catch (err) {
    port.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
});
