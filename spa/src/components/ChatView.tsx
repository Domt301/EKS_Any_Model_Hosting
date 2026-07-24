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
  forgetSession,
  newSessionId,
  streamChatCompletion,
  StreamError,
  type ChatMessage,
  type UsageInfo,
} from '../api/chat';
import type { UserClaims } from '../auth/cognito';
import { MessageBubble, type DisplayMessage } from './MessageBubble';
import { OrbAvatar } from './Backdrop';

interface ChatViewProps {
  user: UserClaims | null;
  getAccessToken: () => Promise<string | null>;
  onRequireLogin: () => void;
  onLogout: () => void;
}

const SUGGESTIONS = [
  { k: 'explain', text: 'Explain how this agent keeps context between turns.' },
  { k: 'write', text: 'Write a haiku about self-hosting a language model.' },
  { k: 'reason', text: 'What are the trade-offs of running vLLM on a single GPU?' },
  { k: 'plan', text: 'Give me a 3-step plan to load-test an inference endpoint.' },
];

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChatView({ user, getAccessToken, onRequireLogin, onLogout }: ChatViewProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const displayName = useMemo(() => {
    if (!user) return '';
    return (user.email as string) || (user.username as string) || (user.sub as string) || '';
  }, [user]);

  const userInitial = (displayName.trim()[0] || 'U').toUpperCase();

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

  const submit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
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

      // Full transcript is sent; the server maintains the windowed context in
      // memory keyed by sessionId (see services/api/app/sessions.py).
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
          sessionId,
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

            if (e.kind === 'aborted') return;
            if (e.kind === 'unauthorized') {
              onRequireLogin();
              return;
            }
            setError(e.message);
          },
        },
      );
    },
    [
      isStreaming,
      messages,
      sessionId,
      getAccessToken,
      onRequireLogin,
      appendToAssistant,
      finalizeAssistant,
    ],
  );

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void submit(input);
    },
    [submit, input],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit(input);
      }
    },
    [submit, input],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newChat = useCallback(async () => {
    abortRef.current?.abort();
    const token = await getAccessToken();
    if (token) void forgetSession(sessionId, token);
    setSessionId(newSessionId());
    setMessages([]);
    setError(null);
    setUsage(null);
  }, [getAccessToken, sessionId]);

  const statusLabel = isStreaming ? 'Thinking…' : 'Online';
  const isEmpty = messages.length === 0;

  return (
    <div className="agent">
      <header className="agent__header">
        <div className="agent__identity">
          <OrbAvatar size="lg" thinking={isStreaming} />
          <div>
            <div className="agent__name">
              Llama Pilot <span className="chip">{config.modelName}</span>
            </div>
            <div className="agent__status">
              <span className={`dot ${isStreaming ? 'dot--thinking' : 'dot--live'}`} />
              {statusLabel} · self-hosted on EKS
            </div>
          </div>
        </div>
        <div className="agent__tools">
          {displayName && (
            <span className="agent__user" title={displayName}>
              {displayName}
            </span>
          )}
          <button type="button" className="btn" onClick={newChat} disabled={isEmpty && !isStreaming}>
            + New chat
          </button>
          <button type="button" className="btn" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div className="agent__stream" ref={scrollRef} aria-live="polite">
        {isEmpty ? (
          <div className="hero">
            <OrbAvatar size="lg" />
            <h2 className="hero__title">How can I help you today?</h2>
            <p className="hero__sub">
              I'm a Llama model running entirely on your private cluster. I remember
              this conversation in memory as we talk — start below or try one of these:
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.k}
                  type="button"
                  className="suggestion"
                  onClick={() => void submit(s.text)}
                >
                  <span className="suggestion__k">{s.k}</span>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} userInitial={userInitial} />
          ))
        )}
      </div>

      {error && (
        <div className="strip strip--error" role="alert">
          {error}
        </div>
      )}

      {usage && (usage.prompt_tokens != null || usage.completion_tokens != null) && (
        <div className="strip strip--usage" aria-label="Token usage">
          {usage.prompt_tokens ?? '?'} prompt · {usage.completion_tokens ?? '?'} completion ·{' '}
          {usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)} total
          tokens
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="sr-only">
          Message the agent
        </label>
        <div className="composer__field">
          <textarea
            id="chat-input"
            className="composer__input"
            value={input}
            placeholder="Message the agent…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={stop}
              aria-label="Stop generating"
              title="Stop"
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="composer__send"
              disabled={!input.trim()}
              aria-label="Send message"
              title="Send"
            >
              ↑
            </button>
          )}
        </div>
        <div className="composer__hint">
          <span>Enter to send</span>
          <span className="sep">·</span>
          <span>Shift + Enter for newline</span>
          <span className="sep">·</span>
          <span>context kept in memory</span>
        </div>
      </form>
    </div>
  );
}
