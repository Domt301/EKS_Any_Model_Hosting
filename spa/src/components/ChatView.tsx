import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { config } from '../config';
import {
  streamChatCompletion,
  StreamError,
  type ChatMessage,
  type UsageInfo,
} from '../api/chat';
import type { UserClaims } from '../auth/cognito';
import { MessageBubble, type DisplayMessage } from './MessageBubble';

interface ChatViewProps {
  user: UserClaims | null;
  getAccessToken: () => Promise<string | null>;
  onRequireLogin: () => void;
  onLogout: () => void;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChatView({ user, getAccessToken, onRequireLogin, onLogout }: ChatViewProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const displayName = useMemo(() => {
    if (!user) return '';
    return (user.email as string) || (user.username as string) || (user.sub as string) || '';
  }, [user]);

  // Auto-scroll to the newest content as it streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Abort any in-flight request if the component unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const appendToAssistant = useCallback((assistantId: string, text: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + text } : m)),
    );
  }, []);

  const finalizeAssistant = useCallback((assistantId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
    );
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    setError(null);
    setUsage(null);

    const token = await getAccessToken();
    if (!token) {
      onRequireLogin();
      return;
    }

    const userMsg: DisplayMessage = { id: newId(), role: 'user', content: trimmed };
    const assistantId = newId();
    const assistantMsg: DisplayMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };

    // Build the request history from what's on screen plus the new user turn.
    const history: ChatMessage[] = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    await streamChatCompletion(
      {
        messages: history,
        accessToken: token,
        temperature: 0.7,
        maxOutputTokens: 512,
        signal: controller.signal,
      },
      {
        onToken: (text) => appendToAssistant(assistantId, text),
        onUsage: (u) => setUsage(u),
        onDone: () => {
          finalizeAssistant(assistantId);
          setIsStreaming(false);
          abortRef.current = null;
        },
        onError: (e: StreamError) => {
          finalizeAssistant(assistantId);
          setIsStreaming(false);
          abortRef.current = null;

          if (e.kind === 'aborted') {
            // User pressed Stop; keep whatever streamed so far, no error banner.
            return;
          }
          if (e.kind === 'unauthorized') {
            onRequireLogin();
            return;
          }
          setError(e.message);
        },
      },
    );
  }, [
    input,
    isStreaming,
    messages,
    getAccessToken,
    onRequireLogin,
    appendToAssistant,
    finalizeAssistant,
  ]);

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void send();
    },
    [send],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setUsage(null);
  }, []);

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="chat__brand">
          <span className="chat__title">Llama Pilot</span>
          <span className="badge badge--model" title="Active model">
            {config.modelName}
          </span>
        </div>
        <div className="chat__actions">
          {displayName && <span className="chat__user" title={displayName}>{displayName}</span>}
          <button type="button" className="btn btn--ghost" onClick={clear} disabled={messages.length === 0}>
            Clear
          </button>
          <button type="button" className="btn btn--ghost" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      <div className="chat__messages" ref={scrollRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="chat__empty">
            <p>Start the conversation by typing a message below.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      {error && (
        <div className="chat__error" role="alert">
          {error}
        </div>
      )}

      {usage && (usage.prompt_tokens != null || usage.completion_tokens != null) && (
        <div className="chat__usage" aria-label="Token usage">
          Tokens — prompt: {usage.prompt_tokens ?? '?'}, completion:{' '}
          {usage.completion_tokens ?? '?'}, total:{' '}
          {usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)}
        </div>
      )}

      <form className="chat__composer" onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          className="chat__input"
          value={input}
          placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button type="button" className="btn btn--danger" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
