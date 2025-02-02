// @flow
import type {
  Asset,
  Dependency,
  PluginOptions,
  BuildSuccessEvent,
  BundledProgressEvent,
} from '@parcel/types';
import type {Diagnostic} from '@parcel/diagnostic';
import type {AnsiDiagnosticResult} from '@parcel/utils';
import type {
  ServerError,
  HMRServerOptions,
  Request,
  Response,
} from './types.js.flow';
import {setHeaders, SOURCES_ENDPOINT} from './Server';

import nullthrows from 'nullthrows';
import url, {fileURLToPath} from 'url';
import path from 'path';
import mime from 'mime-types';
import WebSocket from 'ws';
import invariant from 'assert';
import {Readable} from 'stream';
import {
  ansiHtml,
  createHTTPServer,
  prettyDiagnostic,
  PromiseQueue,
  isDirectoryInside,
  normalizeSeparators,
} from '@parcel/utils';
import SourceMap from '@parcel/source-map';
import formatCodeFrame from '@parcel/codeframe';
import launchEditor from 'launch-editor';

export type HMRAsset = {|
  id: string,
  url: string,
  type: string,
  output: string,
  envHash: string,
  outputFormat: string,
  depsByBundle: {[string]: {[string]: string, ...}, ...},
|};

export type HMRMessage =
  | {|
      type: 'update',
      assets: Array<HMRAsset>,
    |}
  | {|
      type: 'reload',
    |}
  | {|
      type: 'error',
      diagnostics: {|
        ansi: Array<AnsiDiagnosticResult>,
        html: Array<$Rest<AnsiDiagnosticResult, {|codeframe: string|}>>,
      |},
    |};

const FS_CONCURRENCY = 64;
const HMR_ENDPOINT = '/__parcel_hmr';
const CODEFRAME_ENDPOINT = '/__parcel_code_frame';
const SOURCEMAP_ENDPOINT = '/__parcel_source_map';
const EDITOR_ENDPOINT = '/__parcel_launch_editor';
const BROADCAST_MAX_ASSETS = 10000;

export default class HMRServer {
  wss: WebSocket.Server;
  unresolvedError: HMRMessage | null = null;
  options: HMRServerOptions;
  event: BundledProgressEvent | BuildSuccessEvent | null = null;
  stopServer: ?() => Promise<void>;
  pending: boolean = true;
  pendingRequests: Array<[Request, Response]> = [];

  constructor(options: HMRServerOptions) {
    this.options = options;
  }

  buildStart() {
    this.pending = true;
  }

  buildSuccess(event: BuildSuccessEvent) {
    this.pending = false;
    this.event = event;

    if (this.pendingRequests.length > 0) {
      let pendingRequests = this.pendingRequests;
      this.pendingRequests = [];
      for (let [req, res] of pendingRequests) {
        if (!this.handle(req, res)) {
          res.statusCode = 404;
          res.end();
        }
      }
    }
  }

  async start() {
    let server = this.options.devServer;
    if (!server) {
      let result = await createHTTPServer({
        https: this.options.https,
        inputFS: this.options.inputFS,
        outputFS: this.options.outputFS,
        cacheDir: this.options.cacheDir,
        listener: (req, res) => {
          setHeaders(res);
          if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
          }
          if (!this.handle(req, res)) {
            res.statusCode = 404;
            res.end();
          }
        },
      });
      server = result.server;
      server.listen(this.options.port, this.options.host);
      this.stopServer = result.stop;
    } else {
      this.options.addMiddleware?.((req, res) => this.handle(req, res));
    }
    this.wss = new WebSocket.Server({server});

    this.wss.on('connection', ws => {
      if (this.unresolvedError) {
        ws.send(JSON.stringify(this.unresolvedError));
      }
    });

    // $FlowFixMe[incompatible-exact]
    this.wss.on('error', err => this.handleSocketError(err));
  }

  handle(req: Request, res: Response): boolean {
    let {pathname, query} = url.parse(req.originalUrl || req.url);
    if (pathname != null && pathname.startsWith(HMR_ENDPOINT)) {
      let id = pathname.slice(HMR_ENDPOINT.length + 1);
      let bundleGraph = nullthrows(this.event).bundleGraph;
      let asset = bundleGraph.getAssetById(id);
      this.getHotAssetContents(asset).then(output => {
        res.setHeader('Content-Type', mime.contentType(asset.type));
        res.end(output);
      });
      return true;
    } else if (
      pathname?.startsWith(CODEFRAME_ENDPOINT) &&
      req.method === 'POST'
    ) {
      if (this.pending) {
        this.pendingRequests.push([req, res]);
      } else {
        this.serveCodeFrame(req, res);
      }
      return true;
    } else if (pathname?.startsWith(SOURCEMAP_ENDPOINT)) {
      if (this.pending) {
        this.pendingRequests.push([req, res]);
      } else {
        let qs = new URLSearchParams(query || '');
        let filename = qs.get('filename');
        if (!filename) {
          return false;
        }
        this.getSourceMapContents(filename).then(
          map => {
            res.setHeader('Content-Type', 'application/json');
            res.end(map);
          },
          () => {
            res.statusCode = 500;
            res.end();
          },
        );
      }
      return true;
    } else if (pathname?.startsWith(EDITOR_ENDPOINT) && query) {
      let qs = new URLSearchParams(query);
      let file = qs.get('file');
      if (file) {
        // File location might start with /__parcel_source_root if it came from a source map.
        if (file.startsWith(SOURCES_ENDPOINT)) {
          file = file.slice(SOURCES_ENDPOINT.length + 1);
        } else if (!path.isAbsolute(file)) {
          file = path.join(this.options.projectRoot, file);
        }
        launchEditor(file);
      }
      res.end();
      return true;
    }
    return false;
  }

  async stop() {
    if (this.stopServer != null) {
      await this.stopServer();
      this.stopServer = null;
    }
    this.wss.close();
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
  }

  async emitError(options: PluginOptions, diagnostics: Array<Diagnostic>) {
    let renderedDiagnostics = await Promise.all(
      diagnostics.map(d => prettyDiagnostic(d, options)),
    );

    // store the most recent error so we can notify new connections
    // and so we can broadcast when the error is resolved
    this.unresolvedError = {
      type: 'error',
      diagnostics: {
        ansi: renderedDiagnostics,
        html: renderedDiagnostics.map((d, i) => {
          return {
            message: ansiHtml(d.message),
            stack: ansiHtml(d.stack),
            frames: d.frames.map(f => ({
              location: f.location,
              code: ansiHtml(f.code),
            })),
            hints: d.hints.map(hint => ansiHtml(hint)),
            documentation: diagnostics[i].documentationURL ?? '',
          };
        }),
      },
    };

    this.broadcast(this.unresolvedError);
  }

  async getUpdate(
    event: BundledProgressEvent | BuildSuccessEvent,
  ): Promise<?HMRMessage> {
    this.unresolvedError = null;
    this.event = event;

    let changedAssets = new Set(event.changedAssets.values());
    if (changedAssets.size === 0) return Promise.resolve(null);

    let queue = new PromiseQueue({maxConcurrent: FS_CONCURRENCY});
    for (let asset of changedAssets) {
      if (asset.type !== 'js' && asset.type !== 'css') {
        // If all of the incoming dependencies of the asset actually resolve to a JS asset
        // rather than the original, we can mark the runtimes as changed instead. URL runtimes
        // have a cache busting query param added with HMR enabled which will trigger a reload.
        let runtimes = new Set();
        let incomingDeps = event.bundleGraph.getIncomingDependencies(asset);
        let isOnlyReferencedByRuntimes = incomingDeps.every(dep => {
          let resolved = event.bundleGraph.getResolvedAsset(dep);
          let isRuntime = resolved?.type === 'js' && resolved !== asset;
          if (resolved && isRuntime) {
            runtimes.add(resolved);
          }
          return isRuntime;
        });

        if (isOnlyReferencedByRuntimes) {
          for (let runtime of runtimes) {
            changedAssets.add(runtime);
          }

          continue;
        }
      }

      queue.add(async () => {
        let dependencies = event.bundleGraph.getDependencies(asset);
        let depsByBundle = {};
        for (let bundle of event.bundleGraph.getBundlesWithAsset(asset)) {
          let deps = {};
          for (let dep of dependencies) {
            let resolved = event.bundleGraph.getResolvedAsset(dep, bundle);
            if (resolved) {
              deps[getSpecifier(dep)] =
                event.bundleGraph.getAssetPublicId(resolved);
            }
          }
          depsByBundle[bundle.id] = deps;
        }

        return {
          id: event.bundleGraph.getAssetPublicId(asset),
          url: this.getSourceURL(asset),
          type: asset.type,
          // No need to send the contents of non-JS assets to the client.
          output:
            asset.type === 'js' ? await this.getHotAssetContents(asset) : '',
          envHash: asset.env.id,
          outputFormat: asset.env.outputFormat,
          depsByBundle,
        };
      });
    }

    let assets = await queue.run();
    if (assets.length >= BROADCAST_MAX_ASSETS) {
      // Too many assets to send via an update without errors, just reload instead
      return {type: 'reload'};
    } else if (assets.length > 0) {
      return {
        type: 'update',
        assets,
      };
    }
  }

  async getHotAssetContents(asset: Asset): Promise<string> {
    let output = await asset.getCode();
    let bundleGraph = nullthrows(this.event).bundleGraph;
    if (asset.type === 'js') {
      let publicId = bundleGraph.getAssetPublicId(asset);
      output = `parcelHotUpdate['${publicId}'] = function (require, module, exports) {${output}}`;
    }

    let sourcemap = await asset.getMap();
    if (sourcemap) {
      let sourcemapStringified = await sourcemap.stringify({
        format: 'inline',
        sourceRoot:
          (asset.env.isNode() ? this.options.projectRoot : SOURCES_ENDPOINT) +
          '/',
        // $FlowFixMe
        fs: asset.fs,
      });

      invariant(typeof sourcemapStringified === 'string');
      output += `\n//# sourceMappingURL=${sourcemapStringified}`;
      output += `\n//# sourceURL=${encodeURI(this.getSourceURL(asset))}\n`;
    }

    return output;
  }

  getSourceURLEndpoint(): string {
    let origin = '';
    if (
      !this.options.devServer ||
      // $FlowFixMe
      this.bundleGraph?.getEntryBundles().some(b => b.env.isServer())
    ) {
      origin = `http://${this.options.host || 'localhost'}:${
        this.options.port
      }`;
    }
    return origin + HMR_ENDPOINT + '/';
  }

  getSourceURL(asset: Asset): string {
    return this.getSourceURLEndpoint() + asset.id;
  }

  handleSocketError(err: ServerError) {
    if (err.code === 'ECONNRESET') {
      // This gets triggered on page refresh, ignore this
      return;
    }

    this.options.logger.warn({
      origin: '@parcel/reporter-dev-server',
      message: `[${err.code}]: ${err.message}`,
      stack: err.stack,
    });
  }

  broadcast(msg: HMRMessage) {
    const json = JSON.stringify(msg);
    for (let ws of this.wss.clients) {
      ws.send(json);
    }
  }

  async serveCodeFrame(req: Request, res: Response) {
    let distDir = this.options.distDir;
    if (!distDir) {
      res.statusCode = 500;
      res.end();
      return;
    }

    // $FlowFixMe
    let webRequest = new Request('http://localhost' + req.url, {
      method: 'POST',
      headers: req.headers,
      // $FlowFixMe
      body: Readable.toWeb(req),
      duplex: 'half',
    });

    let json = await webRequest.json();

    let sourceMaps = new Map();
    for (let frame of json.frames) {
      try {
        if (frame.fileName) {
          let map;
          let location = this.findSourceMap(frame.fileName);
          if (location.type === 'bundle') {
            // Read the corresponding source map for the bundle.
            if (!sourceMaps.has(location)) {
              let contents = await this.options.outputFS.readFile(
                location.filePath + '.map',
                'utf8',
              );
              let sm = new SourceMap(this.options.projectRoot);
              sm.addVLQMap(JSON.parse(contents));
              sourceMaps.set(location, sm);
            }
            map = sourceMaps.get(location);

            let contents = await this.options.outputFS.readFile(
              location.filePath,
              'utf8',
            );
            frame.compiledLines = getCodeFrame(
              frame.lineNumber,
              frame.columnNumber,
              contents,
              json.contextLines,
              path.extname(location.filePath).slice(1),
            );
            frame.fileName = normalizeSeparators(
              path.relative(this.options.projectRoot, location.filePath),
            );
          } else if (location.type === 'asset') {
            // Get source map from the asset.
            let contents = await location.asset.getCode();
            frame.compiledLines = getCodeFrame(
              frame.lineNumber,
              frame.columnNumber,
              contents,
              json.contextLines,
              location.asset.type,
            );
            frame.fileName = normalizeSeparators(
              path.relative(this.options.projectRoot, location.asset.filePath),
            );
            map = await location.asset.getMap();
            if (!map) {
              throw new Error('Asset does not have a source map');
            }
          }

          if (map && frame.lineNumber != null) {
            // Find the original location in the source map.
            let mapping = map.findClosestMapping(
              frame.lineNumber,
              frame.columnNumber,
            );
            if (mapping) {
              let sourceFileName = mapping.source;
              let source = sourceFileName
                ? map.getSourceContent(sourceFileName) || ''
                : '';
              if (mapping.original && sourceFileName) {
                frame.sourceLineNumber = mapping.original.line;
                frame.sourceColumnNumber = mapping.original.column;
                frame.sourceLines = getCodeFrame(
                  mapping.original.line,
                  mapping.original.column + 1,
                  source,
                  json.contextLines,
                  path.extname(source).slice(1),
                );
                frame.sourceFileName = normalizeSeparators(sourceFileName);
              }
            }
          } else if (location.type === 'source') {
            // This is already a source location. Generate a code frame.
            frame.fileName = normalizeSeparators(
              path.relative(this.options.projectRoot, location.filePath),
            );
            frame.sourceFileName = frame.fileName;
            frame.sourceLineNumber = frame.lineNumber;
            frame.sourceColumnNumber = frame.columnNumber;
            let contents = await this.options.outputFS.readFile(
              location.filePath,
              'utf8',
            );
            frame.sourceLines = getCodeFrame(
              frame.lineNumber,
              frame.columnNumber,
              contents,
              json.contextLines,
              path.extname(location.filePath).slice(1),
            );
          }
        }
      } catch (err) {
        continue;
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(json.frames));
  }

  async getSourceMapContents(filePath: string): Promise<string> {
    let location = await this.findSourceMap(filePath);
    if (location.type === 'bundle') {
      return this.options.outputFS.readFile(location.filePath + '.map', 'utf8');
    }

    let map;
    if (location.type === 'source') {
      // Return an empty source map
      map = new SourceMap(this.options.projectRoot);
      let contents = await this.options.inputFS.readFile(
        location.filePath,
        'utf8',
      );
      map.addEmptyMap(location.filePath, contents);
    } else {
      map = await location.asset.getMap();
      if (!map) {
        throw new Error('Asset does not have a source map');
      }
    }

    let sourcemapStringified = await map.stringify({
      format: 'string',
      sourceRoot: SOURCES_ENDPOINT + '/',
      // $FlowFixMe
      fs: this.options.inputFS,
    });
    invariant(typeof sourcemapStringified === 'string');
    return sourcemapStringified;
  }

  findSourceMap(
    filePath: string,
  ):
    | {|type: 'bundle', filePath: string|}
    | {|type: 'asset', asset: Asset|}
    | {|type: 'source', filePath: string|} {
    let distDir = this.options.distDir;
    if (!distDir) {
      throw new Error('Must have a distDir');
    }

    let event = this.event;
    invariant(event?.type === 'buildSuccess');

    // React generates URLs like rsc://React/Server/file:///foo/bar
    if (filePath.startsWith('rsc://')) {
      let url = new URL(filePath);
      let index = url.pathname.indexOf('/', 1);
      if (index >= 0) {
        filePath = url.pathname.slice(index + 1);
      } else {
        throw new Error('Unexpected RSC URL');
      }
    }

    // Remove public url prefix first, in case it has a protocol/origin.
    let publicUrl = this.options.publicUrl;
    if (publicUrl.endsWith('/')) {
      publicUrl = publicUrl.slice(0, -1);
    }

    if (publicUrl.length > 0 && filePath.startsWith(publicUrl + '/')) {
      filePath = filePath.slice(publicUrl.length + 1);
    }

    // Get path from URL.
    if (filePath.startsWith('file://')) {
      filePath = fileURLToPath(filePath);
    } else {
      if (/^https?:\/\//.test(filePath)) {
        let url = new URL(filePath);
        filePath = url.pathname.slice(1);
      }

      // If public url is just a subpath, strip it.
      if (publicUrl.length > 0 && filePath.startsWith(publicUrl)) {
        filePath = filePath.slice(publicUrl.length);
      }
    }

    // If url starts with /__parcel_hmr, get source map by asset id.
    let hmrEndpoint = this.getSourceURLEndpoint();
    if (filePath.startsWith(hmrEndpoint)) {
      let id = filePath.slice(hmrEndpoint.length);
      return {
        type: 'asset',
        asset: event.bundleGraph.getAssetById(id),
      };
    }

    if (filePath.startsWith('/') || path.isAbsolute(filePath)) {
      filePath = path.normalize(filePath);
    } else {
      filePath = path.join(distDir, filePath);
    }

    // If the file is inside the distDir, it's a bundle path.
    if (isDirectoryInside(filePath, distDir)) {
      return {type: 'bundle', filePath: filePath};
    }

    // Otherwise, assume this refers to a source file.
    // This can happen if the server uses --enable-source-maps,
    // in which case Node will have already mapped the location.
    if (isDirectoryInside(filePath, this.options.projectRoot)) {
      return {type: 'source', filePath};
    }

    throw new Error('Source map not found');
  }
}

function getSpecifier(dep: Dependency): string {
  if (typeof dep.meta.placeholder === 'string') {
    return dep.meta.placeholder;
  }

  return dep.specifier;
}

function getCodeFrame(
  line: number,
  column: number,
  source: string,
  contextLines: number,
  language: string,
): string {
  return formatCodeFrame(
    source,
    [
      {
        start: {
          line,
          column,
        },
        end: {
          line,
          column,
        },
      },
    ],
    {
      useColor: true,
      syntaxHighlighting: true,
      padding: {
        before: contextLines,
        after: contextLines,
      },
      language,
    },
  );
}
