// Jev (TypeSafe AI's System One model): cheap, fast typed decisions over a `state`.
//
//   POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key from Secrets "jev">
//   { state, model: "jev-latest", questions: { <id>: { type: "choice", instructions, criteria } } }
//   → { model, answers: { <id>: { type: "choice", choice, probabilities, confidence } }, usage }
//
// Jev doesn't generate text, so it isn't a ModelProvider: AgentRunner.decide() asks it Choice
// questions and re-asks the fallback model (claude:haiku) whatever comes back unsure.
// The key is read per request, so `applyant secrets set jev` takes effect without a restart,
// and it only ever travels in the Authorization header: nothing here logs a request's headers.
import type { Secrets } from '../../secrets/secrets.ts';

export const JEV_SECRET = 'jev';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
/** $42 per billion input tokens; output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 42 / 1e9;
/** The API takes at most 255 options per Choice. */
export const JEV_MAX_OPTIONS = 255;

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export class JevError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

export interface JevClientOptions {
  secrets: Pick<Secrets, 'get'>;
  fetch?: typeof fetch;
  url?: string;
  model?: string;
  /** Retries on 429 / 529 / network errors. */
  retries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JevClient {
  readonly name = 'jev' as const;
  private readonly o: JevClientOptions;

  constructor(options: JevClientOptions) {
    this.o = options;
  }

  /** Jev is on when its key is stored. */
  async available(): Promise<boolean> {
    return !!(await this.key());
  }

  private async key(): Promise<string | null> {
    try {
      return (await this.o.secrets.get(JEV_SECRET))?.trim() || null;
    } catch {
      return null;
    }
  }

  async ask(req: JevRequest, signal: AbortSignal): Promise<JevResponse> {
    const key = await this.key();
    if (!key) throw new JevError('no Jev key (applyant secrets set jev)', 401);
    const fetchFn = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? wait;
    const retries = this.o.retries ?? 3;
    const body = JSON.stringify({
      state: req.state,
      model: this.o.model ?? JEV_MODEL,
      questions: req.questions,
    });
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let res: Response;
      try {
        res = await fetchFn(this.o.url ?? JEV_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs ?? 30_000)]),
        });
      } catch (err) {
        signal.throwIfAborted();
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new JevError(`Jev unreachable: ${(err as Error).message}`, null);
      }
      if ((res.status === 429 || res.status === 529) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new JevError(`Jev HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
      }
      const json = (await res.json()) as Partial<JevResponse>;
      if (!json || typeof json.answers !== 'object' || json.answers === null) {
        throw new JevError('Jev returned no answers', res.status);
      }
      return {
        model: typeof json.model === 'string' ? json.model : (this.o.model ?? JEV_MODEL),
        answers: json.answers as Record<string, JevChoiceAnswer>,
        usage: {
          input_tokens: Number(json.usage?.input_tokens ?? 0),
          output_tokens: Number(json.usage?.output_tokens ?? 0),
        },
      };
    }
  }
}
