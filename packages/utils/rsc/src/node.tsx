/* @jsxRuntime automatic */
import type { IncomingMessage, ServerResponse } from 'http';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import type { ReactNode } from 'react';

import {Readable} from 'stream';
import {renderToReadableStream, createTemporaryReferenceSet} from 'react-server-dom-parcel/server.edge';
import {RSCToHTMLOptions, RSCOptions, renderHTML as renderHTMLBase, callAction as callActionBase, renderDevError} from './server';

export function renderRSC(root: any, options?: RSCOptions): Readable {
  return Readable.fromWeb(renderToReadableStream(root, options) as NodeReadableStream);
}

export async function renderHTML(root: any, options?: RSCToHTMLOptions): Promise<Readable> {
  let htmlStream = await renderHTMLBase(root, options);
  return Readable.fromWeb(htmlStream as NodeReadableStream);
}

const temporaryReferencesSymbol = Symbol.for('temporaryReferences');

export interface RenderRequestOptions extends RSCToHTMLOptions {
  renderError?: (err: Error) => ReactNode
}

export async function renderRequest(request: IncomingMessage, response: ServerResponse, root: any, options?: RenderRequestOptions): Promise<void> {
  options = {
    ...options,
    temporaryReferences: options?.temporaryReferences ?? (request as any)[temporaryReferencesSymbol]
  };
  
  if (request.headers.accept?.includes('text/html')) {
    try {
      let html = await renderHTML(root, options);
      response.setHeader('Content-Type', 'text/html');
      html.pipe(response);
    } catch (err) {
      response.statusCode = 500;
      let error = err instanceof Error ? err : new Error(String(err));
      let renderedError;
      try {
        renderedError = options?.renderError 
          ? await renderHTMLBase(options.renderError(error), options)
          : await renderDevError(error, options);
      } catch {
        renderedError = '<h1>Something went wrong!</h1>';
      }
      if (typeof renderedError === 'string') {
        response.end(renderedError);
      } else {
        Readable.fromWeb(renderedError as NodeReadableStream).pipe(response);
      }
    }
  } else {
    response.setHeader('Content-Type', 'text/x-component');
    renderRSC(root, options).pipe(response);
  }
}

export async function callAction(request: IncomingMessage, id: string | null | undefined): Promise<{result: any}> {
  (request as any)[temporaryReferencesSymbol] ??= createTemporaryReferenceSet();

  let req = new Request('http://localhost' + request.url, {
    method: 'POST',
    headers: request.headers as any,
    body: Readable.toWeb(request) as ReadableStream,
    // @ts-ignore
    duplex: 'half'
  });

  (req as any)[temporaryReferencesSymbol] = (request as any)[temporaryReferencesSymbol];
  return callActionBase(req, id);
}
