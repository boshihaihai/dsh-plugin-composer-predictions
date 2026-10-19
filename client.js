/**
 * Composer predictions — Client half.
 *
 * Replicates the observably-relevant part of ChatGPT/Codex composer predictions:
 *  1. after an assistant turn finishes, ask the Host to predict the next user message;
 *  2. render the prediction as subdued ghost text **inline inside the composer**,
 *     at the caret position where the next message would start (the composer's
 *     placeholder is hidden while the ghost is shown);
 *  3. Tab puts the text into the draft without sending it;
 *  4. typing / sending / switching turns dismisses the prediction;
 *  5. "Show predictions" appears in Settings → General.
 *
 * The Client half asks the Host over one private same-origin HTTP route
 * (`POST /composer-predictions/predict`), so the plugin needs no Remote/typert
 * registration and stays installable as an ordinary package.
 *
 * DSH owns its Lexical composer internally (no public decoration API), so the
 * inline ghost is a view-only layer: a DOM node placed inside the composer's
 * text-area container (`.grow`), absolutely aligned to the editor's content
 * box, with the same font metrics. It never enters the Lexical document and
 * never reaches the draft/submit path; accepting uses InputActions.insertText,
 * exactly like typing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-composer-predictions',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'composer-predictions';
    const PREDICT_ROUTE = '/composer-predictions/predict';
    const PREFERENCE_KEY = 'dsh.composer-predictions.enabled';
    const DEBUG_KEY = 'dsh.composer-predictions.debug';
    const STYLE_ID = 'dsh-composer-predictions-style';

    const zh = {
      'prediction.pressTabToAccept': '按 Tab 接受',
      'prediction.accept': '填入',
      'prediction.dismiss': '忽略',
      'settings.title': '显示输入预测',
      'settings.description': '助手回复结束后，根据当前对话预测你的下一条消息；按 Tab 填为可编辑草稿',
    };
    const en = {
      'prediction.pressTabToAccept': 'Press Tab to accept',
      'prediction.accept': 'Insert',
      'prediction.dismiss': 'Dismiss',
      'settings.title': 'Show predictions',
      'settings.description': 'Predict your next message from the conversation after an assistant reply; press Tab to insert it as an editable draft',
    };

    /**
     * Ask the Host for one prediction over the plugin's private route.
     *
     * The Host publishes a per-start capability token into the authenticated
     * index page; it travels back as a header so no other local client can use
     * the route. The body is `{ sessionId, generationTrigger? }`; the reply is
     * the Host result object.
     */
    async function requestPrediction(request, signal) {
      const token = typeof window.__DSH_COMPOSER_PREDICTIONS_TOKEN__ === 'string'
        ? window.__DSH_COMPOSER_PREDICTIONS_TOKEN__
        : '';
      if (token === '') throw new Error('prediction capability token is missing; refresh the page');
      const response = await fetch(PREDICT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-composer-predictions-token': token },
        body: JSON.stringify(request),
        signal,
        credentials: 'same-origin',
      });
      if (!response.ok) {
        let message = `prediction request failed (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (typeof body?.error?.message === 'string' && body.error.message !== '') message = body.error.message;
        } catch {
          // Non-JSON error body; keep the status message.
        }
        throw new Error(message);
      }
      return await response.json();
    }

    function createSnapshotStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set: (next) => {
          if (Object.is(next, value)) return;
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    function readPreference() {
      try {
        const stored = window.localStorage.getItem(PREFERENCE_KEY);
        if (stored === '0') return false;
        if (stored === '1') return true;
      } catch {
        // localStorage may be unavailable; default remains on.
      }
      return true;
    }

    function createPreference() {
      const store = createSnapshotStore(readPreference());
      return {
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        set: (value) => {
          try {
            window.localStorage.setItem(PREFERENCE_KEY, value === true ? '1' : '0');
          } catch {
            // Persistence is best-effort; the in-memory toggle still works.
          }
          store.set(value === true);
        },
      };
    }

    const IDLE = Object.freeze({ sessionId: null, phase: 'idle', text: '', error: null, raw: null });

    function createPredictionStore() {
      const store = createSnapshotStore(IDLE);
      // In-memory only: navigation preserves ready suggestions, never pending requests.
      const readyBySession = new Map();
      let controller = null;
      const cancel = () => {
        if (controller !== null) {
          controller.abort();
          controller = null;
        }
      };
      return {
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        cancel,
        activate: (sessionId) => {
          cancel();
          store.set(readyBySession.get(sessionId) ?? IDLE);
        },
        matches: (sessionId, request) => controller === request && store.getSnapshot().sessionId === sessionId,
        clear: (sessionId) => {
          if (sessionId === undefined) readyBySession.clear();
          else readyBySession.delete(sessionId);
          if (sessionId !== undefined) {
            const current = store.getSnapshot();
            if (current.sessionId !== null && current.sessionId !== sessionId) return;
          }
          cancel();
          store.set(IDLE);
        },
        begin: (sessionId, nextController) => {
          cancel();
          readyBySession.delete(sessionId);
          controller = nextController;
          store.set({ sessionId, phase: 'loading', text: '', error: null, raw: null });
        },
        settle: (sessionId, request, text, raw) => {
          if (controller !== request || request.signal.aborted) return;
          controller = null;
          if (text === '') store.set({ sessionId: null, phase: 'idle', text: '', error: null, raw: raw ?? null });
          else {
            const ready = { sessionId, phase: 'ready', text, error: null, raw: raw ?? null };
            readyBySession.delete(sessionId);
            readyBySession.set(sessionId, ready);
            // Bound retained transcript/debug data in long-lived browser sessions.
            if (readyBySession.size > 100) readyBySession.delete(readyBySession.keys().next().value);
            store.set(ready);
          }
        },
        fail: (sessionId, request, message, raw) => {
          if (controller !== request || request.signal.aborted) return;
          controller = null;
          store.set({ sessionId, phase: 'idle', text: '', error: message, raw: raw ?? null });
        },
      };
    }

    /**
     * View-only inline ghost layer.
     *
     * Lives inside the composer's text-area container as an absolutely
     * positioned sibling of the Lexical root, so it paints exactly where the
     * next message would be typed but never becomes editor content. The layer
     * follows layout changes and editor remounts without a polling timer.
     */
    function createGhostLayer() {
      let host = null;
      let textEl = null;
      let input = null;
      let placeholder = null;
      let savedMinHeight = '';
      let appliedMinHeight = '';
      let baseMinHeight = 0;
      let container = null;
      let savedPosition = '';
      let positioned = false;

      const ensureStyle = () => {
        if (document.getElementById(STYLE_ID) !== null) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '[data-composer-placeholder][data-prediction-hidden]{display:none!important}';
        (document.head ?? document.documentElement).appendChild(style);
      };

      const editor = () => document.querySelector('[data-composer-input]');

      const clear = () => {
        if (host !== null) {
          host.remove();
          host = null;
        }
        textEl = null;
        if (placeholder !== null) {
          placeholder.removeAttribute('data-prediction-hidden');
          placeholder = null;
        }
        if (input !== null) {
          if (input.style.minHeight === appliedMinHeight) input.style.minHeight = savedMinHeight;
          input = null;
        }
        if (positioned && container !== null && container.style.position === 'relative') {
          container.style.position = savedPosition;
        }
        container = null;
        positioned = false;
        savedMinHeight = '';
        appliedMinHeight = '';
      };

      const hidePlaceholder = () => {
        const grow = input === null ? null : input.parentElement;
        if (grow === null) return;
        const next = grow.querySelector('[data-composer-placeholder]');
        if (next !== placeholder) {
          if (placeholder !== null) placeholder.removeAttribute('data-prediction-hidden');
          placeholder = next;
        }
        if (placeholder !== null && !placeholder.hasAttribute('data-prediction-hidden')) {
          placeholder.setAttribute('data-prediction-hidden', '1');
        }
      };

      const layout = () => {
        if (input === null || textEl === null) return;
        const cs = getComputedStyle(input);
        const px = (value) => Number.parseFloat(value) || 0;
        Object.assign(textEl.style, {
          left: `${input.offsetLeft + px(cs.borderLeftWidth) + px(cs.paddingLeft)}px`,
          top: `${input.offsetTop + px(cs.borderTopWidth) + px(cs.paddingTop)}px`,
          width: `${Math.max(0, input.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight))}px`,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          textAlign: cs.textAlign,
          direction: cs.direction,
        });
        const padding = cs.boxSizing === 'border-box'
          ? px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth)
          : 0;
        const height = Math.ceil(textEl.getBoundingClientRect().height + padding);
        // Always measure against the original minimum so a wider editor can shrink again.
        appliedMinHeight = `${Math.max(baseMinHeight, height)}px`;
        if (input.style.minHeight !== appliedMinHeight) input.style.minHeight = appliedMinHeight;
      };

      const show = (text, hint) => {
        clear();
        ensureStyle();
        const target = editor();
        const grow = target === null ? null : target.parentElement;
        if (grow === null) return false;
        const cs = getComputedStyle(target);
        input = target;
        savedMinHeight = target.style.minHeight;
        baseMinHeight = Number.parseFloat(cs.minHeight) || 0;
        container = grow;
        savedPosition = grow.style.position;
        positioned = getComputedStyle(grow).position === 'static';
        if (positioned) grow.style.position = 'relative';

        host = document.createElement('div');
        host.setAttribute('data-composer-predictions', 'inline');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden;';

        textEl = document.createElement('div');
        textEl.textContent = text;
        textEl.setAttribute('data-composer-predictions', 'inline-text');
        textEl.style.cssText = [
          'position:absolute',
          'white-space:pre-wrap',
          'word-break:break-word',
          'overflow-wrap:anywhere',
          'color:var(--dsw-alias-label-tertiary, #8a8f98)',
          'opacity:.8',
          'pointer-events:none',
          'user-select:none',
        ].join(';');
        if (typeof hint === 'string' && hint !== '') {
          const hintEl = document.createElement('span');
          hintEl.setAttribute('data-composer-predictions', 'inline-hint');
          hintEl.textContent = `  ${hint}`;
          hintEl.style.cssText = 'font-size:11px;letter-spacing:0;white-space:nowrap;margin-inline-start:8px;border:1px solid var(--dsw-alias-border-l2,#c4c7cc);border-radius:4px;padding:1px 4px;';
          textEl.appendChild(hintEl);
        }
        host.appendChild(textEl);
        grow.appendChild(host);
        hidePlaceholder();
        layout();
        return true;
      };

      const sync = (text, hint) => {
        if (host === null || !host.isConnected || editor() !== input || input.parentElement !== container) {
          show(text, hint);
          return;
        }
        const next = textEl === null ? null : textEl.firstChild;
        if (next !== null && next.nodeValue !== text) {
          next.nodeValue = text;
        }
        layout();
        hidePlaceholder();
      };

      return { show, sync, clear, isActive: () => host !== null && host.isConnected };
    }

    /**
     * Composer-dock entry: schedules one prediction after each finished turn
     * and paints it inline in the editor. It renders only a diagnostic node
     * when the local debug flag is set.
     */
    function PredictionDock(props) {
      const { session, input, inputActions, predict, prediction, preferences, t, sessionId } = props;
      const enabled = React.useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
      const state = React.useSyncExternalStore(prediction.subscribe, prediction.getSnapshot);
      const running = session !== undefined && session !== null && session.running === true;
      const draft = input !== undefined && input !== null && typeof input.draft === 'string' ? input.draft : '';
      const draftEmpty = draft === '';
      const previous = React.useRef({ sessionId, running });
      const timer = React.useRef(null);
      const composing = React.useRef(false);
      const latest = React.useRef(null);
      latest.current = { sessionId, running, enabled, draftEmpty };
      const layer = React.useRef(null);
      if (layer.current === null) layer.current = createGhostLayer();
      const ghostLayer = layer.current;
      const editor = () => document.querySelector('[data-composer-input]');
      // Lexical can report the new draft a render later than the browser input event.
      const editorEmpty = () => {
        const target = editor();
        return target !== null && (target.textContent ?? '').replace(/[\r\n\u200b]/g, '') === '';
      };

      const stop = React.useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        prediction.cancel();
      }, [prediction]);

      const dismiss = React.useCallback(() => {
        stop();
        prediction.clear(sessionId);
        ghostLayer.clear();
      }, [stop, prediction, sessionId, ghostLayer]);

      React.useEffect(() => {
        prediction.activate(sessionId);
        return () => {
          stop();
          ghostLayer.clear();
        };
      }, [stop, prediction, sessionId, ghostLayer]);

      React.useEffect(() => {
        const prior = previous.current;
        previous.current = { sessionId, running };
        const switched = prior.sessionId !== sessionId;
        if (switched) composing.current = false;
        if (running || !enabled || !draftEmpty) {
          stop();
          prediction.clear(enabled ? sessionId : undefined);
          return;
        }
        if (switched) return;
        if (!prior.running || !sessionId || composing.current) return;
        // A turn just finished; let the transcript settle before asking.
        timer.current = setTimeout(() => {
          timer.current = null;
          const current = latest.current;
          if (current.sessionId !== sessionId || current.running || !current.enabled
            || !current.draftEmpty || composing.current || !editorEmpty()) return;
          try { if (window.localStorage.getItem(DEBUG_KEY) === '1') console.info('[composer-predictions] turn finished, predicting', sessionId); } catch { /* no console */ }
          const controller = new AbortController();
          prediction.begin(sessionId, controller);
          const deadline = setTimeout(() => {
            if (!prediction.matches(sessionId, controller)) return;
            prediction.fail(sessionId, controller, 'prediction request timed out');
            controller.abort();
          }, 35000);
          controller.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
          Promise.resolve()
            .then(() => {
              if (controller.signal.aborted) return null;
              return predict({ sessionId, generationTrigger: 'catch_up' }, controller.signal);
            })
            .then((value) => {
              if (controller.signal.aborted || !prediction.matches(sessionId, controller)) return;
              const suggestion = value !== null && value !== undefined && typeof value.suggestion === 'string'
                ? value.suggestion.trim()
                : '';
              prediction.settle(sessionId, controller, suggestion, value);
            }, (error) => {
              if (controller.signal.aborted || !prediction.matches(sessionId, controller)) return;
              const message = error instanceof Error ? error.message : String(error);
              prediction.fail(sessionId, controller, message);
              try { console.warn('[composer-predictions] prediction failed:', message); } catch { /* no console */ }
            }).finally(() => clearTimeout(deadline));
        }, 350);
      }, [sessionId, running, enabled, draftEmpty, predict, prediction, stop]);

      const active = enabled
        && !running
        && draftEmpty
        && state.phase === 'ready'
        && state.sessionId === sessionId
        && typeof state.text === 'string'
        && state.text !== '';

      // Observe only while visible; coalesce DOM and width changes into one frame.
      React.useEffect(() => {
        if (!active) {
          ghostLayer.clear();
          return;
        }
        const hint = t('prediction.pressTabToAccept');
        ghostLayer.show(state.text, hint);
        let frame = null;
        let observed = null;
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        const observeEditor = () => {
          const target = editor();
          if (target === observed) return;
          resizeObserver?.disconnect();
          observed = target;
          if (target !== null) {
            resizeObserver?.observe(target);
            if (target.parentElement) resizeObserver?.observe(target.parentElement);
          }
        };
        function schedule() {
          if (frame !== null) return;
          frame = window.requestAnimationFrame(() => {
            frame = null;
            if (!editorEmpty() || composing.current) {
              dismiss();
              return;
            }
            ghostLayer.sync(state.text, hint);
            observeEditor();
          });
        }
        observeEditor();
        const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
        mutationObserver?.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('resize', schedule);
        return () => {
          mutationObserver?.disconnect();
          resizeObserver?.disconnect();
          window.removeEventListener('resize', schedule);
          if (frame !== null) window.cancelAnimationFrame(frame);
          ghostLayer.clear();
        };
      }, [active, state.text, t, ghostLayer, dismiss]);

      // Restrict shortcuts to the editor; toolbar Tab navigation remains native.
      React.useEffect(() => {
        const inEditor = (target) => {
          const root = editor();
          return root !== null && (target === root || root.contains(target));
        };
        const onEdit = (event) => {
          if (!inEditor(event.target)) return;
          if (event.type === 'compositionstart') composing.current = true;
          dismiss();
        };
        const onCompositionEnd = () => { composing.current = false; };
        const onSubmit = (event) => {
          const card = document.querySelector('[data-composer-card]');
          if (card !== null && (card.contains(event.target) || event.target?.contains?.(card))) dismiss();
        };
        const onKeyDown = (event) => {
          if (!inEditor(document.activeElement) || event.defaultPrevented
            || composing.current || event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape' || event.key === 'Enter') {
            if (event.key === 'Escape' && active) {
              event.preventDefault();
              event.stopPropagation();
            }
            dismiss();
            return;
          }
          if (!active || !ghostLayer.isActive() || !editorEmpty()) return;
          if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (inputActions?.insertText?.(state.text, inputActions.captureInsertion?.())) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
            editor()?.focus();
          }
        };
        const editEvents = ['beforeinput', 'input', 'paste', 'drop', 'compositionstart'];
        for (const type of editEvents) window.addEventListener(type, onEdit, true);
        window.addEventListener('compositionend', onCompositionEnd, true);
        window.addEventListener('submit', onSubmit, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          for (const type of editEvents) window.removeEventListener(type, onEdit, true);
          window.removeEventListener('compositionend', onCompositionEnd, true);
          window.removeEventListener('submit', onSubmit, true);
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [active, state.text, inputActions, ghostLayer, dismiss]);

      let debugEnabled = false;
      try {
        debugEnabled = window.localStorage.getItem(DEBUG_KEY) === '1';
      } catch {
        debugEnabled = false;
      }
      if (!debugEnabled) return active ? h('span', {
        role: 'status',
        'aria-live': 'polite',
        style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
      }, `${state.text} — ${t('prediction.pressTabToAccept')}`) : null;
      return h('div', {
        'data-composer-predictions': 'debug',
        style: {
          position: 'fixed',
          left: '8px',
          bottom: '8px',
          zIndex: 99999,
          pointerEvents: 'none',
          font: '11px/14px monospace',
          color: 'var(--dsw-alias-state-warn-primary)',
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          padding: '4px 6px',
          maxWidth: '80vw',
        },
      }, `running=${String(running)} phase=${state.phase} error=${state.error ?? ''} text=${JSON.stringify(state.text)} draft=${JSON.stringify(draft)} sessionId=${sessionId}`);
    }

    /** Settings → General → Composer preference row. */
    function PredictionSettingsRow(props) {
      const { preferences, t } = props;
      const enabled = React.useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', padding: '14px 0' };
      const rowTextStyle = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 };
      const rowTitleStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '20px' };
      const rowDescStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' };
      return h('div', { style: rowStyle, 'data-composer-predictions': 'settings-row' },
        h('div', { style: rowTextStyle },
          h('div', { style: rowTitleStyle }, t('settings.title')),
          h('div', { style: rowDescStyle }, t('settings.description'))),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': t('settings.title'),
          style: {
            flex: 'none',
            width: '36px',
            height: '20px',
            borderRadius: '999px',
            border: 'none',
            padding: '2px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: enabled ? 'flex-end' : 'flex-start',
            background: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            transition: 'background 120ms ease',
          },
          onClick: () => {
            if (enabled) props.prediction.clear();
            preferences.set(!enabled);
          },
        }, h('span', {
          style: { width: '16px', height: '16px', borderRadius: '50%', background: 'var(--dsw-alias-bg-overlay)' },
        })));
    }

    /** Services required for the locale dictionary and UI contributions. */
    const inject = ['slots', 'locale'];

    async function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'composer-predictions: dictionaries');

      const prediction = createPredictionStore();
      const preferences = createPreference();
      const predict = (request, signal) => requestPrediction(request, signal);

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'composer-predictions',
        order: 12,
        locale: NS,
        inject: () => ({ predict, prediction, preferences }),
      }, PredictionDock));
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'composer-predictions',
        order: 21,
        locale: NS,
        inject: () => ({ preferences, prediction }),
      }, PredictionSettingsRow));

      return () => {
        prediction.clear();
        document.getElementById(STYLE_ID)?.remove();
      };
    }

    return { inject, apply };
  },
});
