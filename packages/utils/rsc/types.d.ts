declare module 'react-server-dom-parcel/client' {
  type TemporaryReferenceSet = {__ref: true};
  type ReactCustomFormAction = {
    name?: string;
    action?: string;
    encType?: string;
    method?: string;
    target?: string;
    data?: null | FormData;
  };
  type EncodeFormActionCallback = <A>(
    id: any,
    args: Promise<A>,
  ) => ReactCustomFormAction;
  type Options = {
    nonce?: string;
    encodeFormAction?: EncodeFormActionCallback;
    temporaryReferences?: TemporaryReferenceSet;
    replayConsoleLogs?: boolean;
    environmentName?: string;
  };

  export function createFromFetch<T>(
    res: Promise<Response>,
    options?: Options,
  ): Promise<T>;
  export function createFromReadableStream<T>(
    stream: ReadableStream,
    options?: Options,
  ): Promise<T>;
  export function encodeReply(
    value: any,
    options?: {
      temporaryReferences?: TemporaryReferenceSet;
      signal?: AbortSignal | null | undefined;
    },
  ): Promise<string | URLSearchParams | FormData>;
  export function createTemporaryReferenceSet(): TemporaryReferenceSet;

  type CallServerCallback = <T>(id: string, args: any[]) => Promise<T>;
  export function setServerCallback(cb: CallServerCallback): void;
}

declare module 'react-server-dom-parcel/client.edge' {
  export function createFromReadableStream<T>(
    stream: ReadableStream,
  ): Promise<T>;
}

declare module 'react-server-dom-parcel/server.edge' {
  type TemporaryReferenceSet = {__ref: true};
  type Options = {
    environmentName?: string | (() => string);
    filterStackFrame?: (url: string, functionName: string) => boolean;
    identifierPrefix?: string;
    signal?: AbortSignal;
    temporaryReferences?: TemporaryReferenceSet;
    onError?: (error: unknown) => void;
    onPostpone?: (reason: string) => void;
  };

  export function renderToReadableStream(
    value: any,
    options?: Options,
  ): ReadableStream;
  export function loadServerAction(
    id: string,
  ): Promise<(...args: any[]) => Promise<any>>;
  export function decodeReply<T>(
    body: string | FormData,
    options?: {temporaryReferences?: TemporaryReferenceSet},
  ): Promise<T>;
  export function decodeAction(
    body: FormData,
  ): Promise<(...args: any[]) => Promise<any>>;
  export function createTemporaryReferenceSet(): TemporaryReferenceSet;
}

declare module 'react-dom/server.edge' {
  export * from 'react-dom/server';
}
