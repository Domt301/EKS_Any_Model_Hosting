import type { ChatRole } from '../api/chat';

export interface DisplayMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** True while this assistant message is still streaming. */
  streaming?: boolean;
}

interface MessageBubbleProps {
  message: DisplayMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const label = isUser ? 'You' : 'Assistant';

  return (
    <div
      className={`bubble-row ${isUser ? 'bubble-row--user' : 'bubble-row--assistant'}`}
    >
      <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--assistant'}`}>
        <span className="bubble__role">{label}</span>
        <div className="bubble__content">
          {message.content}
          {message.streaming && <span className="bubble__caret" aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
}
