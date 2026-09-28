// Embeddings, in-process: EmbeddingGemma-300M (multilingual, incl. Ukrainian, Russian,
// German and Greek) through @huggingface/transformers on onnxruntime-node, on the CPU.
// Vectors are Matryoshka-truncated to 256 dims and re-normalised for storage in facts_vec.
//
// The model (~300 MB, int8) is fetched on first use into the models directory. `HashEmbedder`
// is a deterministic, offline stand-in (tests, and machines that can't fetch the model): it
// hashes words and character trigrams, so it only finds lexical overlap.
import { createHash } from 'node:crypto';
import type { Logger } from '../util/log.ts';

export const EMBEDDING_DIMS = 256;

export type EmbedKind = 'query' | 'document';

export interface Embedder {
  /** Identifies the vector space: vectors from different ids are not comparable. */
  readonly id: string;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
  close?(): Promise<void>;
}

/** The float32 bytes SQLite stores for a vector. */
export function vectorBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
// EmbeddingGemma's retrieval prompts (model card).
const PREFIX: Record<EmbedKind, string> = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
};
const BATCH = 16;
const MAX_TOKENS = 512;

type Tokenizer = (
  texts: string[],
  o: { padding: boolean; truncation: boolean; max_length: number },
) => Promise<unknown> | unknown;
type Model = (inputs: unknown) => Promise<{ sentence_embedding: { tolist(): number[][] } }>;

export interface GemmaEmbedderOptions {
  /** Where the model files are cached. */
  cacheDir: string;
  log: Logger;
  /** onnx dtype: q8 (default, ~300 MB) · q4 · fp32. */
  dtype?: 'q8' | 'q4' | 'fp32';
}

export class GemmaEmbedder implements Embedder {
  readonly id = `embeddinggemma-300m@${EMBEDDING_DIMS}`;
  private readonly o: GemmaEmbedderOptions;
  private loading: Promise<{ tokenizer: Tokenizer; model: Model }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GemmaEmbedderOptions) {
    this.o = options;
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { tokenizer, model } = await this.load();
    // One inference at a time: onnxruntime already uses every core.
    const run = this.queue.then(async () => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        signal?.throwIfAborted();
        const batch = texts.slice(i, i + BATCH).map((t) => PREFIX[kind] + t);
        const inputs = await tokenizer(batch, {
          padding: true,
          truncation: true,
          max_length: MAX_TOKENS,
        });
        const { sentence_embedding } = await model(inputs);
        for (const row of sentence_embedding.tolist()) {
          out.push(normalise(Float32Array.from(row.slice(0, EMBEDDING_DIMS))));
        }
      }
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private load(): Promise<{ tokenizer: Tokenizer; model: Model }> {
    this.loading ??= (async () => {
      const started = Date.now();
      const hf = await import('@huggingface/transformers');
      hf.env.cacheDir = this.o.cacheDir;
      hf.env.allowLocalModels = false;
      const tokenizer = (await hf.AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as Tokenizer;
      const model = (await hf.AutoModel.from_pretrained(MODEL_ID, {
        dtype: this.o.dtype ?? 'q8',
      })) as unknown as Model;
      this.o.log.info('embedding model loaded', {
        model: MODEL_ID,
        ms: Date.now() - started,
      });
      return { tokenizer, model };
    })();
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }
}

/**
 * Feature hashing over lowercase words and character trigrams. Deterministic and offline;
 * similar only where texts share words, so it is a stand-in, not a semantic model.
 */
export class HashEmbedder implements Embedder {
  readonly id = `hash-v1@${EMBEDDING_DIMS}`;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashVector(t));
  }
}

export function hashVector(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  const words =
    text
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const add = (feature: string, weight: number) => {
    const h = createHash('sha1').update(feature).digest();
    const i = h.readUInt16BE(0) % EMBEDDING_DIMS;
    v[i] = (v[i] ?? 0) + ((h[2] ?? 0) & 1 ? weight : -weight);
  };
  for (const w of words) {
    add(`w:${w}`, 1);
    const padded = `^${w}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.3);
  }
  return normalise(v);
}
