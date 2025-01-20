import type { ErrorInfo } from 'react-dom/client';

// Server dependencies.
import {renderToReadableStream, loadServerAction, decodeReply, decodeAction, createTemporaryReferenceSet} from 'react-server-dom-parcel/server.edge';
import {injectRSCPayload} from 'rsc-html-stream/server';

// Client dependencies, used for SSR.
// These must run in the same environment as client components (e.g. same instance of React).
import {createFromReadableStream} from 'react-server-dom-parcel/client.edge' with {env: 'react-client'};
import {renderToReadableStream as renderHTMLToReadableStream} from 'react-dom/server.edge' with {env: 'react-client'};
import {ComponentType, ReactNode} from 'react' with {env: 'react-client'};

export interface RSCOptions {
  // environmentName?: string | (() => string),
  // filterStackFrame?: (url: string, functionName: string) => boolean,
  identifierPrefix?: string,
  signal?: AbortSignal,
  temporaryReferences?: any,
  onError?: (error: unknown) => void,
  onPostpone?: (reason: string) => void,
}

export function renderRSC(root: any, options?: RSCOptions): ReadableStream {
  return renderToReadableStream(root, options);
}

export interface RSCToHTMLOptions {
  component?: ComponentType,
  identifierPrefix?: string;
  namespaceURI?: string;
  nonce?: string;
  progressiveChunkSize?: number;
  signal?: AbortSignal;
  temporaryReferences?: any,
  onError?: (error: unknown, errorInfo?: ErrorInfo) => string | void;
}

export async function renderRSCToHTML(root: any, options?: RSCToHTMLOptions): Promise<ReadableStream> {
  let rscStream = renderToReadableStream(root, options);

  // Use client react to render the RSC payload to HTML.
  let [s1, s2] = rscStream.tee();
  let data: Promise<ReactNode>;
  function Content() {
    // Important: this must be constructed inside a component for preinit scripts to be inserted.
    data ??= createFromReadableStream<ReactNode>(s1);
    return data;
  }

  let htmlStream = await renderHTMLToReadableStream(<Content />, {
    ...options,
    bootstrapScriptContent: (options?.component as any)?.bootstrapScript
  });

  return htmlStream.pipeThrough(injectRSCPayload(s2));
}

export interface RenderRequestOptions extends RSCToHTMLOptions {
  headers?: HeadersInit
}

const temporaryReferencesSymbol = Symbol.for('temporaryReferences')

export async function renderRequest(request: Request, root: any, options?: RenderRequestOptions): Promise<Response> {
  options = {
    ...options,
    temporaryReferences: options?.temporaryReferences ?? (request as any)[temporaryReferencesSymbol]
  };

  if (request.headers.get('Accept')?.includes('text/html')) {
    let html = await renderRSCToHTML(root, options);
    return new Response(html, {
      headers: {
        ...options?.headers,
        'Content-Type': 'text/html'
      }
    });
  } else {
    let rscStream = renderToReadableStream(root, options);
    return new Response(rscStream, {
      headers: {
        ...options?.headers,
        'Content-Type': 'text/x-component'
      }
    });
  }
}

export async function callAction(request: Request, id: string | null | undefined): Promise<{result: any}> {
  (request as any)[temporaryReferencesSymbol] ??= createTemporaryReferenceSet();

  if (id) {
    let action = await loadServerAction(id);
    let body = request.headers.get('content-type')?.includes('multipart/form-data') 
      ? await request.formData()
      : await request.text();
    let args = await decodeReply<any[]>(body, {
      temporaryReferences: (request as any)[temporaryReferencesSymbol]
    });

    let result = action.apply(null, args);
    try {
      // Wait for any mutations
      await result;
    } catch {
      // Handle the error on the client
    }
    return {result};
  } else {
    // Form submitted by browser (progressive enhancement).
    let formData = await request.formData();
    let action = await decodeAction(formData);
    // Don't catch error here: this should be handled by the caller (e.g. render an error page).
    let result = await action();
    return {result};
  }
}
