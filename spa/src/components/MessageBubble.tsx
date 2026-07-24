import type { ChatRole } from '../api/chat';
import { OrbAvatar } from './Backdrop';

export interface DisplayMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** True while this assistant message is still streaming. */
  streaming?: boolean;
}

interface MessageBubbleProps {
  message: DisplayMessage;
  /** Initial to show in the user avatar (e.g. first letter of the email). */
  userInitial?: string;
}

export function MessageBubble({ message, userInitial = 'U' }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const awaitingFirstToken = message.streaming && message.content.length === 0;

  return (
    <div className={`turn ${isUser ? 'turn--user' : 'turn--assistant'}`}>
      <div className="turn__avatar">
        {isUser ? (
          <div className="turn__avatar--user" aria-hidden="true">
            {userInitial}
          </div>
        ) : (
          <OrbAvatar size="sm" thinking={message.streaming} />
        )}
      </div>
      <div className={`bubble ${isUser ? 'bubble--user' : 'bubble--assistant'}`}>
        <span className="bubble__label">{isUser ? 'You' : 'Agent'}</span>
        <div className="bubble__content">
          {awaitingFirstToken ? (
            <span className="thinking" aria-label="Thinking">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <>
              {message.content}
              {message.streaming && <span className="caret" aria-hidden="true" />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
