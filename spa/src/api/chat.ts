/**
 * Chat completion client.
 *
 * POSTs to the FastAPI backend and parses a Server-Sent-Events (SSE) stream,
 * emitting tokens as they arrive. Only user/assistant roles are ever sent — the
 * system prompt is applied server-side, never by the client.
 */

import { config } from '../config';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface StreamCallbacks {
  onToken: (text: string) => void;
  onUsage?: (usage: UsageInfo) => void;
  onDone?: () => void;
  onError?: (error: StreamError) => void;
}

export type StreamErrorKind = 'unauthorized' | 'rate_limited' | 'network' | 'server' | 'aborted';

export class StreamError extends Error {
  kind: StreamErrorKind;
  status?: number;
  constructor(kind: StreamErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
    this.status = status;
  }
}

export interface StreamRequest {
  messages: ChatMessage[];
  accessToken: string;
  /** Opaque conversation id; enables server-side in-memory context. */
  sessionId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

const CHAT_PATH = '/api/v1/chat/completions';

/**
 * Stream a chat completion. Resolves when the stream completes or errors;
 * results are delivered through the provided callbacks.
 */
export async function streamChatCompletion(
  req: StreamRequest,
  callbacks: StreamCallbacks,
): Promise<void> {
  const { messages, accessToken, sessionId, temperature, maxOutputTokens, signal } = req;

  const payload = {
    // Guard: never forward a system message even if one slipped into history.
    messages: messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content })),
    ...(sessionId ? { session_id: sessionId } : {}),
    temperature: temperature ?? 0.7,
    max_output_tokens: maxOutputTokens ?? 512,
    stream: true,
  };

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (isAbort(e)) {
      callbacks.onError?.(new StreamError('aborted', 'Request cancelled.'));
      return;
    }
    callbacks.onError?.(
      new StreamError('network', e instanceof Error ? e.message : 'Network error.'),
    );
    return;
  }

  if (!res.ok) {
    callbacks.onError?.(await toHttpError(res));
    return;
  }

  if (!res.body) {
    callbacks.onError?.(new StreamError('server', 'Empty response body from server.'));
    return;
  }

  try {
    await parseSseStream(res.body, callbacks, signal);
  } catch (e) {
    if (isAbort(e)) {
      callbacks.onError?.(new StreamError('aborted', 'Request cancelled.'));
      return;
    }
    callbacks.onError?.(
      new StreamError('network', e instanceof Error ? e.message : 'Stream read error.'),
    );
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * Best-effort: ask the server to drop a conversation's in-memory context.
 * Failures are ignored — memory also expires on its own (TTL).
 */
export async function forgetSession(sessionId: string, accessToken: string): Promise<void> {
  try {
    await fetch(`${config.apiBaseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* ignore */
  }
}

/** Generate an opaque conversation id for server-side memory keying. */
export function newSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function toHttpError(res: Response): Promise<StreamError> {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  if (res.status === 401) {
    return new StreamError('unauthorized', 'Your session has expired. Please sign in again.', 401);
  }
  if (res.status === 429) {
    return new StreamError('rate_limited', 'Rate limit reached. Please wait a moment and try again.', 429);
  }
  return new StreamError('server', detail || `Request failed (${res.status}).`, res.status);
}

/**
 * Read the response body as a stream, split on SSE frame boundaries ("\n\n"),
 * and dispatch parsed frames to the callbacks.
 */
async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line (\n\n). Handle CRLF too.
      let sepIndex: number;
      while ((sepIndex = indexOfFrameBoundary(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^(\r?\n){2}/, '');
        const finished = handleFrame(rawFrame, callbacks);
        if (finished) {
          return;
        }
      }
    }

    // Flush any trailing frame that lacked a terminating blank line.
    const tail = buffer.trim();
    if (tail) {
      handleFrame(tail, callbacks);
    }
    callbacks.onDone?.();
  } finally {
    reader.releaseLock();
  }
}

/** Find the index of the next SSE frame boundary (\n\n or \r\n\r\n). */
function indexOfFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/**
 * Parse a single SSE frame (one or more `event:` / `data:` lines) and dispatch.
 * Returns true when the stream is finished (a `done` event or [DONE] sentinel).
 */
function handleFrame(rawFrame: string, callbacks: StreamCallbacks): boolean {
  const lines = rawFrame.split(/\r?\n/);
  let eventType = 'message';
  const dataParts: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }

  const data = dataParts.join('\n');
  if (data === '' && eventType === 'message') {
    return false;
  }

  // OpenAI-style terminal sentinel.
  if (data.trim() === '[DONE]') {
    callbacks.onDone?.();
    return true;
  }

  switch (eventType) {
    case 'token':
      dispatchToken(data, callbacks);
      return false;
    case 'usage':
      dispatchUsage(data, callbacks);
      return false;
    case 'done':
      callbacks.onDone?.();
      return true;
    case 'error':
      callbacks.onError?.(new StreamError('server', extractErrorMessage(data)));
      return true;
    default:
      // Unlabeled `message` events: try to interpret as a token payload.
      dispatchToken(data, callbacks);
      return false;
  }
}

/** A token event's data may be raw text or JSON like {"text":"..."} / delta. */
function dispatchToken(data: string, callbacks: StreamCallbacks): void {
  const text = extractTokenText(data);
  if (text) callbacks.onToken(text);
}

function extractTokenText(data: string): string {
  const trimmed = data.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.token === 'string') return obj.token;
      if (typeof obj.content === 'string') return obj.content;
      if (typeof obj.delta === 'string') return obj.delta;
      // OpenAI chat.completion.chunk shape.
      const choices = obj.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === 'string') return delta.content;
      return '';
    } catch {
      // Not JSON after all — treat as raw text.
      return data;
    }
  }
  return data;
}

function dispatchUsage(data: string, callbacks: StreamCallbacks): void {
  try {
    const usage = JSON.parse(data) as UsageInfo;
    callbacks.onUsage?.(usage);
  } catch {
    /* ignore malformed usage frame */
  }
}

function extractErrorMessage(data: string): string {
  try {
    const obj = JSON.parse(data) as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
  } catch {
    /* fall through */
  }
  return data || 'The server reported an error.';
}
