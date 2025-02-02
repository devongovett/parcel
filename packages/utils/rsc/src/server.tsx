/* @jsxRuntime automatic */
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

export async function renderHTML(root: any, options?: RSCToHTMLOptions): Promise<ReadableStream> {
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
    bootstrapScriptContent: (options?.component as any)?.bootstrapScript,
  });

  return htmlStream.pipeThrough(injectRSCPayload(s2));
}

export interface RenderRequestOptions extends RSCToHTMLOptions {
  headers?: HeadersInit,
  renderError?: (err: Error) => ReactNode
}

const temporaryReferencesSymbol = Symbol.for('temporaryReferences')

export async function renderRequest(request: Request, root: any, options?: RenderRequestOptions): Promise<Response> {
  options = {
    ...options,
    temporaryReferences: options?.temporaryReferences ?? (request as any)[temporaryReferencesSymbol]
  };

  if (request.headers.get('Accept')?.includes('text/html')) {
    try {
      let html = await renderHTML(root, options);
      return new Response(html, {
        headers: {
          ...options?.headers,
          'Content-Type': 'text/html'
        }
      });
    } catch (err) {
      let error = err instanceof Error ? err : new Error(String(err));
      let res;
      try {
        res = options?.renderError 
          ? await renderHTML(options.renderError(error), options)
          : await renderDevError(error, options);
      } catch {
        res = '<h1>Something went wrong!</h1>';
      }
      return new Response(res, {
        status: 500,
        headers: {
          ...options?.headers,
          'Content-Type': 'text/html'
        }
      });
    }
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

export async function renderDevError(error: Error, options: RSCToHTMLOptions): Promise<ReadableStream | string> {
  if (process.env.NODE_ENV !== 'production') {
    let content = (
      <html>
        <meta charSet="utf-8" />
        <title>Error</title>
        <body>
          <noscript>
            <h1>Error: {error.message}</h1>
            <pre>{error.stack}</pre>
          </noscript>
        </body>
      </html>
    );

    // Load bootstrap script containing error overlay, and re-throw server error on the client.
    let bootstrapScript = (options?.component as any)?.bootstrapScript;
    bootstrapScript += '.then(() => {';
    bootstrapScript += `let err = new Error(${JSON.stringify(error.message)});`;
    bootstrapScript += `err.stack = ${JSON.stringify(error.stack)};`;
    bootstrapScript += 'throw err;';
    bootstrapScript += '})';

    return await renderHTML(content, {
      ...options,
      component: {
        bootstrapScript
      } as any
    });
  } else {
    return '<h1>Something went wrong!</h1>';
  }
}
