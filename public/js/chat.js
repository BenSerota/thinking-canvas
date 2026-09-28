/**
 * Chat Panel — handles message display and user input
 */

export class ChatPanel {
  constructor(containerEl, onSend) {
    this.container = containerEl;
    this.onSend = onSend;
    this.messages = [];
    // True while a turn is in flight: composing stays possible, sending
    // does not.
    this.busy = false;

    this._buildUI();
  }

  _buildUI() {
    this.container.innerHTML = `
      <div class="chat-header">
        <div class="chat-title">Thinking Canvas</div>
        <div class="chat-subtitle">AI with visual thinking</div>
      </div>
      <div class="chat-messages" id="chatMessages" role="log" aria-live="polite"></div>
      <div class="chat-input-area">
        <label for="chatInput" class="sr-only">Message</label>
        <textarea id="chatInput" placeholder="Type a message..." rows="1"></textarea>
        <button id="chatSend" aria-label="Send">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
          </svg>
        </button>
      </div>
    `;

    this.messagesEl = this.container.querySelector('#chatMessages');
    this.inputEl = this.container.querySelector('#chatInput');
    this.sendBtn = this.container.querySelector('#chatSend');

    this.sendBtn.addEventListener('click', () => this._handleSend());
    this.inputEl.addEventListener('keydown', (e) => {
      // keyCode 229 = IME composition in progress (older browsers).
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this._handleSend();
      }
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });
  }

  _handleSend() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.addMessage('user', text);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    if (this.onSend) this.onSend(text);
  }

  addMessage(role, text) {
    this.messages.push({ role, text });

    const msgEl = document.createElement('div');
    msgEl.className = `chat-message chat-message-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    return bubble;
  }

  /**
   * Add a message that streams in word by word.
   * Returns a controller object with { append(text), finish() }
   */
  addStreamingMessage(role) {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-message chat-message-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble streaming';

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);

    let fullText = '';

    return {
      append: (text) => {
        fullText += text;
        bubble.textContent = fullText;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      finish: () => {
        bubble.classList.remove('streaming');
        this.messages.push({ role, text: fullText });
      },
      getText: () => fullText,
    };
  }

  /**
   * Add a collapsible thinking block that fills in as the model's reasoning
   * streams. Returns a controller object with { append(text), finish() }.
   */
  addStreamingThinking() {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message chat-message-thinking';

    const details = document.createElement('details');
    details.className = 'chat-thinking';

    const summary = document.createElement('summary');
    summary.textContent = 'Thinking…';

    const content = document.createElement('div');
    content.className = 'chat-thinking-content';

    details.appendChild(summary);
    details.appendChild(content);
    msgEl.appendChild(details);
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    let fullText = '';
    return {
      append: (text) => {
        fullText += text;
        content.textContent = fullText;
        content.scrollTop = content.scrollHeight;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      finish: () => {
        summary.textContent = 'Thought process';
      },
    };
  }

  /**
   * Render a failed turn: a distinct bubble with a Retry button. Error
   * bubbles never enter the history. `onRetry` fires at most once.
   */
  addErrorMessage(text, onRetry) {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message chat-message-assistant';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-error';
    bubble.setAttribute('role', 'alert');

    const label = document.createElement('span');
    label.textContent = text;
    bubble.appendChild(label);

    if (typeof onRetry === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-retry';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        onRetry();
      });
      bubble.appendChild(btn);
    }

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return bubble;
  }

  /** The textarea stays usable during a turn; only sending is gated. */
  setInputEnabled(enabled) {
    this.busy = !enabled;
    this.sendBtn.disabled = !enabled;
    if (enabled) this.inputEl.focus();
  }

  getHistory() {
    return this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.text }));
  }
}
