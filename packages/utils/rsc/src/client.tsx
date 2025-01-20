import { ReactNode, startTransition, useInsertionEffect } from 'react';
import {createFromReadableStream, createFromFetch, encodeReply, setServerCallback, createTemporaryReferenceSet} from 'react-server-dom-parcel/client';
import {rscStream} from 'rsc-html-stream/client';
import { hydrateRoot, HydrationOptions, Root } from 'react-dom/client';

// Stream in initial RSC payload embedded in the HTML.
let initialRSCPayload: Promise<ReactNode>;
function RSCRoot({value, cb}: {value?: ReactNode, cb?: () => void}) {
  initialRSCPayload ??= createFromReadableStream<ReactNode>(rscStream);
  useInsertionEffect(() => {
    cb?.();
  });
  return value === undefined ? initialRSCPayload : value;
}

export type CallServerCallback = <T>(id: string, args: any[]) => Promise<T>;
export interface HydrateOptions extends HydrationOptions {
  handleServerAction?: CallServerCallback,
  onHmrReload?: () => void
}

export function hydrate(options?: HydrateOptions): (value: ReactNode, cb?: () => void) => void {
  if (options?.handleServerAction) {
    setServerCallback(options.handleServerAction);
  }

  if (options?.onHmrReload) {
    window.addEventListener('parcelhmrreload', e => {
      e.preventDefault();
      options?.onHmrReload?.();
    });
  }

  let root: Root;
  startTransition(() => {
    root = hydrateRoot(document, <RSCRoot />, options);
  });

  return (value: ReactNode, cb?: () => void) => {
    startTransition(() => {
      root?.render(<RSCRoot value={value} cb={() => {cb?.(); cb = undefined}} />);
    });
  };
}

export interface RSCRequestInit extends Omit<RequestInit, 'body'> {
  body?: any
}

export async function fetchRSC<T>(url: string | URL | Request, options?: RSCRequestInit): Promise<T> {
  const temporaryReferences = createTemporaryReferenceSet();
  const response = fetch(url, {
    ...options,
    headers: {
      Accept: 'text/x-component',
      ...options?.headers,
    },
    body: options && 'body' in options 
      ? await encodeReply(options.body, {temporaryReferences, signal: options?.signal})
      : undefined,
  });

  return createFromFetch<T>(response, {temporaryReferences});
}
