import { toRecordTarget } from './read-options.js';
import {
  isSensitiveQueryParam,
  REDACTED_VALUE,
  redactText,
  redactUrl,
} from './redact.js';
import type { SessionEventSource, SessionEvents } from './session-events.js';
import type {
  CdpEvent,
  CdpManager,
  CdpSubscription,
} from '../platform/cdp-manager.js';
import type { ConsoleLevel, ConsoleRecord } from '../tools/types/events.js';

export const CONSOLE_EVENTS = [
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
] as const;

/** Console levels recorded by default. */
export const DEFAULT_CONSOLE_LEVELS: readonly ConsoleLevel[] = ['error'];

/** Recent console messages remembered to drop replays. */
const MAX_REMEMBERED_MESSAGES = 1000;

type RemoteObjectPreviewProperty = {
  name?: string;
  type?: string;
  subtype?: string;
  value?: string;
  valuePreview?: RemoteObjectPreview;
};

type RemoteObjectPreview = {
  type?: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: RemoteObjectPreviewProperty[];
};

type RemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: RemoteObjectPreview;
};

type CallFrame = { url?: string; lineNumber?: number; columnNumber?: number };

type StackTrace = { callFrames?: CallFrame[] };

type ConsoleApiCalledParams = {
  type?: string;
  args?: RemoteObject[];
  timestamp?: number;
  stackTrace?: StackTrace;
};

type ExceptionThrownParams = {
  timestamp?: number;
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: RemoteObject;
    stackTrace?: StackTrace;
  };
};

/**
 * Maps a `Runtime.consoleAPICalled` type to a recorded level. `assert` is
 * an error; `dir`, `table`, `trace` and the like are `log`.
 *
 * @param type - The console call type.
 * @returns The level.
 */
export function toConsoleLevel(type: string | undefined): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
    case 'info':
    case 'debug':
      return type;
    default:
      return 'log';
  }
}

/**
 * Formats one preview property like DevTools: strings are quoted, primitives
 * are written as they are, objects show their short description. A nested
 * object with its own preview is formatted recursively, so its sensitive
 * fields are redacted too.
 *
 * @param property - The property preview.
 * @returns Its text.
 */
function formatPreviewProperty(property: RemoteObjectPreviewProperty): string {
  if (property.valuePreview !== undefined) {
    const nested = property.valuePreview;
    if ((nested.properties?.length ?? 0) > 0 || nested.overflow === true) {
      const text = formatPreview(nested);
      if (text !== undefined) {
        return text;
      }
    }
  }
  const value = property.value ?? '';
  switch (property.type) {
    case 'string':
      return `'${value}'`;
    case 'undefined':
      return 'undefined';
    case 'accessor':
      return '(…)';
    case 'object':
      if (property.subtype === 'array') {
        return value === '' ? 'Array' : value;
      }
      // A nested plain object: DevTools shows `{…}` rather than `Object`.
      return value === '' || value === 'Object' ? '{…}' : value;
    case 'function':
      if (value === '') {
        return 'ƒ';
      }
      return value.startsWith('ƒ') ? value : `ƒ ${value}`;
    default:
      return value;
  }
}

/**
 * Checks whether a preview property name holds a secret. The query-parameter
 * rules already include the body field names, so this covers `privateKey`,
 * `password`, `token`, `key`, `*token`, `*key`, `*secret`, `seed`, `pass`, …
 * with the shared allowlist (`publicKey`, `sortKey`, `sourceToken`, …).
 *
 * @param name - The property name.
 * @returns True if the value must be redacted.
 */
function isSensitivePreviewName(name: string): boolean {
  return isSensitiveQueryParam(name);
}

/**
 * Formats an object preview like DevTools: `{a: 1, b: 'x'}` for an object,
 * `[1, 2]` for an array, with `…` when the preview overflowed. A property
 * whose name is sensitive prints `[REDACTED]` instead of its value, at every
 * nesting level and for the named properties of an array; a name that is not
 * an array index prints as `name: value`, like DevTools. Console output is
 * recorded and published, so a logged private key or mnemonic must not reach
 * it.
 *
 * A plain string property is quoted as DevTools shows it; its contents are
 * not scanned for secrets beyond the whole-text pass (`redactText`) that
 * redacts URLs, JWTs and `Bearer` tokens afterwards.
 *
 * Only a plain object, an array and a proxy have their properties rendered.
 * Other object subtypes show their description (`Map(2)`, `Date`, `RegExp`,
 * `Uint8Array(2)`, `Error: boom`), whose values are not printed.
 *
 * @param preview - The CDP preview.
 * @returns Its text, or undefined when the preview cannot be rendered.
 */
function formatPreview(
  preview: RemoteObjectPreview | undefined,
): string | undefined {
  if (preview === undefined) {
    return undefined;
  }
  const properties = preview.properties ?? [];
  const overflow = preview.overflow === true;
  if (preview.subtype === 'array') {
    const values = properties.map((property) => {
      const name = property.name ?? '';
      // Numeric names are the elements; a named property (`a.privateKey`)
      // prints with its name and is redacted when the name is sensitive.
      if (/^\d*$/u.test(name)) {
        return formatPreviewProperty(property);
      }
      const value = isSensitivePreviewName(name)
        ? REDACTED_VALUE
        : formatPreviewProperty(property);
      return `${name}: ${value}`;
    });
    if (overflow) {
      values.push('…');
    }
    return `[${values.join(', ')}]`;
  }
  // The description holds the useful summary, for example `Map(2)`, and no
  // entry values: a secret stored in a Map, Set or a weak collection is
  // never printed.
  if (preview.subtype !== undefined && preview.subtype !== 'proxy') {
    return preview.description;
  }
  if (preview.type !== 'object' && preview.type !== 'function') {
    return preview.description;
  }
  if (properties.length === 0 && !overflow) {
    return preview.description;
  }
  const fields = properties.map((property) => {
    const name = property.name ?? '?';
    const value = isSensitivePreviewName(name)
      ? REDACTED_VALUE
      : formatPreviewProperty(property);
    return `${name}: ${value}`;
  });
  if (overflow) {
    fields.push('…');
  }
  return `{${fields.join(', ')}}`;
}

/**
 * Formats one console argument like DevTools does in a single line: the
 * value of a primitive, the preview of an object, else its description.
 * An `error` subtype keeps its description, which holds the stack.
 *
 * @param arg - The remote object.
 * @returns Its text.
 */
function formatArg(arg: RemoteObject): string {
  if (arg.unserializableValue !== undefined) {
    return arg.unserializableValue;
  }
  switch (arg.type) {
    case 'string':
      return typeof arg.value === 'string' ? arg.value : '';
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
      return String(arg.value as number | boolean);
    default:
      break;
  }
  if (arg.subtype === 'null') {
    return 'null';
  }
  if (arg.subtype === 'error' && arg.description !== undefined) {
    return arg.description;
  }
  const preview = formatPreview(arg.preview);
  if (preview !== undefined) {
    return preview;
  }
  if (arg.description !== undefined) {
    return arg.description;
  }
  return arg.value === undefined ? '' : JSON.stringify(arg.value);
}

/**
 * Formats the arguments of a console call like DevTools: a leading string is
 * a format string, whose `%s`, `%d`, `%i`, `%f`, `%o`, `%O` and `%c`
 * specifiers consume the following arguments (`%c` consumes and drops one,
 * `%%` writes a literal `%`). Other arguments are appended, space-separated.
 *
 * @param args - The console arguments.
 * @returns The text of the message.
 */
export function formatConsoleArgs(args: RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first?.type !== 'string' || typeof first.value !== 'string') {
    return args.map(formatArg).join(' ');
  }
  let consumed = 0;
  const text = first.value.replace(
    /%([%sdifoOc])/gu,
    (match, specifier: string) => {
      if (specifier === '%') {
        return '%';
      }
      const arg = rest[consumed];
      if (arg === undefined) {
        return match;
      }
      consumed += 1;
      if (specifier === 'c') {
        return '';
      }
      if (specifier === 'd' || specifier === 'i' || specifier === 'f') {
        const raw = arg.unserializableValue ?? arg.value;
        const number = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(number)) {
          return 'NaN';
        }
        return specifier === 'f' ? String(number) : String(Math.trunc(number));
      }
      return formatArg(arg);
    },
  );
  return [text, ...rest.slice(consumed).map(formatArg)].join(' ');
}

/**
 * Builds the text of an uncaught exception: the Chrome prefix and the
 * exception value, without repeating a value the prefix already ends with.
 *
 * @param prefix - The `exceptionDetails.text` of Chrome.
 * @param description - The formatted exception value.
 * @returns The text.
 */
function exceptionText(
  prefix: string,
  description: string | undefined,
): string {
  if (description === undefined) {
    return prefix;
  }
  const trimmed = prefix.trimEnd();
  if (
    trimmed === 'Uncaught' ||
    trimmed === 'Uncaught (in promise)' ||
    !trimmed.endsWith(description)
  ) {
    return `${trimmed} ${description}`;
  }
  return trimmed;
}

/**
 * Returns `url:line:column` (1-based) of the first frame with a URL.
 *
 * @param frame - The call frame.
 * @returns The redacted location, or undefined without a URL.
 */
function formatLocation(frame: CallFrame | undefined): string | undefined {
  if (!frame?.url) {
    return undefined;
  }
  return `${redactUrl(frame.url)}:${(frame.lineNumber ?? 0) + 1}:${
    (frame.columnNumber ?? 0) + 1
  }`;
}

/**
 * Builds the console record of a CDP event, before level filtering.
 *
 * @param event - A `Runtime.consoleAPICalled` or `Runtime.exceptionThrown`
 * event.
 * @returns The record without its `seq`, and the CDP timestamp (epoch ms).
 */
export function toConsoleRecord(
  event: CdpEvent,
): { record: Omit<ConsoleRecord, 'seq'>; timestamp?: number } | undefined {
  const target = toRecordTarget(event.target);
  if (event.method === 'Runtime.consoleAPICalled') {
    const params = event.params as ConsoleApiCalledParams;
    const location = formatLocation(params.stackTrace?.callFrames?.[0]);
    return {
      timestamp: params.timestamp,
      record: {
        t: Math.round(params.timestamp ?? event.t),
        target,
        level: toConsoleLevel(params.type),
        text: redactText(formatConsoleArgs(params.args ?? [])),
        ...(location === undefined ? {} : { location }),
      },
    };
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const params = event.params as ExceptionThrownParams;
    const details = params.exceptionDetails ?? {};
    const description =
      details.exception === undefined
        ? undefined
        : formatArg(details.exception);
    const prefix = details.text ?? 'Uncaught';
    const text = exceptionText(prefix, description);
    const location = formatLocation(
      details.stackTrace?.callFrames?.[0] ??
        (details.url === undefined
          ? undefined
          : {
              url: details.url,
              lineNumber: details.lineNumber,
              columnNumber: details.columnNumber,
            }),
    );
    return {
      timestamp: params.timestamp,
      record: {
        t: Math.round(params.timestamp ?? event.t),
        target,
        level: 'error',
        text: redactText(text),
        ...(location === undefined ? {} : { location }),
        uncaught: true,
      },
    };
  }
  return undefined;
}

/**
 * Records console messages and uncaught exceptions of every page and the
 * Extension service worker, at the levels in the session config.
 *
 * `Runtime.enable` replays the messages Chrome kept for a target. Replays
 * are dropped: messages from before the source started, and messages seen
 * already (same target, time, level and text).
 */
export class ConsoleSource implements SessionEventSource {
  readonly #remembered = new Set<string>();

  /**
   * @param manager - The session's CDP manager.
   * @param events - The session's events.
   * @returns The subscription.
   */
  async start(
    manager: CdpManager,
    events: SessionEvents,
  ): Promise<CdpSubscription> {
    const startedAt = Date.now();
    return manager.subscribe({
      events: CONSOLE_EVENTS,
      onEvent: (event) => this.#onEvent(event, events, startedAt),
    });
  }

  /**
   * Records one event when it is not a replay and its level is recorded.
   * The replay key is remembered before the level filter, so widening the
   * levels later does not record the replayed messages again.
   *
   * @param event - The CDP event.
   * @param events - The session's events.
   * @param startedAt - When this source started, epoch ms.
   */
  #onEvent(event: CdpEvent, events: SessionEvents, startedAt: number): void {
    const built = toConsoleRecord(event);
    if (built === undefined) {
      return;
    }
    const { record, timestamp } = built;
    if (timestamp !== undefined) {
      if (timestamp < startedAt) {
        return;
      }
      const key = `${record.target.id}\u0000${timestamp}\u0000${record.level}\u0000${record.text}`;
      if (this.#remembered.has(key)) {
        return;
      }
      this.#remembered.add(key);
      if (this.#remembered.size > MAX_REMEMBERED_MESSAGES) {
        const [oldest] = this.#remembered;
        this.#remembered.delete(oldest);
      }
    }
    if (!events.config.consoleLevels.includes(record.level)) {
      return;
    }
    events.buffer.append<ConsoleRecord>('console', record);
  }
}
