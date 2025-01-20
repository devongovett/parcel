import type { IncomingMessage, ServerResponse } from 'http';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

import {Readable} from 'stream';
import {renderToReadableStream, createTemporaryReferenceSet} from 'react-server-dom-parcel/server.edge';
import {RSCToHTMLOptions, RSCOptions, renderRSCToHTML as renderRSCToHTMLBase, callAction as callActionBase} from './server';

export function renderRSC(root: any, options?: RSCOptions): Readable {
  return Readable.fromWeb(renderToReadableStream(root, options) as NodeReadableStream);
}

export async function renderHTML(root: any, options?: RSCToHTMLOptions): Promise<Readable> {
  let htmlStream = await renderRSCToHTMLBase(root, options);
  return Readable.fromWeb(htmlStream as NodeReadableStream);
}

const temporaryReferencesSymbol = Symbol.for('temporaryReferences')

export async function renderRequest(request: IncomingMessage, response: ServerResponse, root: any, options?: RSCToHTMLOptions): Promise<void> {
  options = {
    ...options,
    temporaryReferences: options?.temporaryReferences ?? (request as any)[temporaryReferencesSymbol]
  };
  
  if (request.headers.accept?.includes('text/html')) {
    let html = await renderHTML(root, options);
    response.setHeader('Content-Type', 'text/html');
    html.pipe(response);
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
