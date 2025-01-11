// @flow

import {Reporter} from '@parcel/plugin';
import HMRServer from './HMRServer';
import Server from './Server';
import {NodeRunner} from './NodeRunner';

let servers: Map<number, Server> = new Map();
let hmrServers: Map<number, HMRServer> = new Map();
let nodeRunners: Map<string, NodeRunner> = new Map();
export default (new Reporter({
  async report({event, options, logger}) {
    let {serveOptions, hmrOptions} = options;
    let server = serveOptions ? servers.get(serveOptions.port) : undefined;
    let hmrPort =
      (hmrOptions && hmrOptions.port) || (serveOptions && serveOptions.port);
    let hmrServer = hmrPort ? hmrServers.get(hmrPort) : undefined;
    let nodeRunner = nodeRunners.get(options.instanceId);
    switch (event.type) {
      case 'watchStart': {
        if (serveOptions) {
          // If there's already a server when watching has just started, something
          // is wrong.
          if (server) {
            return logger.warn({
              message: 'Trying to create the devserver but it already exists.',
            });
          }

          let serverOptions = {
            ...serveOptions,
            projectRoot: options.projectRoot,
            cacheDir: options.cacheDir,
            // Override the target's publicUrl as that is likely meant for production.
            // This could be configurable in the future.
            publicUrl: serveOptions.publicUrl ?? '/',
            inputFS: options.inputFS,
            outputFS: options.outputFS,
            packageManager: options.packageManager,
            logger,
            hmrOptions,
          };

          server = new Server(serverOptions);
          servers.set(serveOptions.port, server);
          const devServer = await server.start();

          if (hmrOptions && hmrOptions.port === serveOptions.port) {
            let hmrServerOptions = {
              port: serveOptions.port,
              host: hmrOptions.host,
              devServer,
              addMiddleware: handler => {
                server?.middleware.push(handler);
              },
              logger,
              https: options.serveOptions ? options.serveOptions.https : false,
              cacheDir: options.cacheDir,
              inputFS: options.inputFS,
              outputFS: options.outputFS,
              projectRoot: options.projectRoot,
            };
            hmrServer = new HMRServer(hmrServerOptions);
            hmrServers.set(serveOptions.port, hmrServer);
            await hmrServer.start();
            return;
          }
        }

        let port = hmrOptions?.port;
        if (typeof port === 'number') {
          let hmrServerOptions = {
            port,
            host: hmrOptions?.host,
            logger,
            https: options.serveOptions ? options.serveOptions.https : false,
            cacheDir: options.cacheDir,
            inputFS: options.inputFS,
            outputFS: options.outputFS,
            projectRoot: options.projectRoot,
          };
          hmrServer = new HMRServer(hmrServerOptions);
          hmrServers.set(port, hmrServer);
          await hmrServer.start();
        }
        break;
      }
      case 'watchEnd':
        if (serveOptions) {
          if (!server) {
            return logger.warn({
              message:
                'Could not shutdown devserver because it does not exist.',
            });
          }
          await server.stop();
          servers.delete(server.options.port);
        }
        if (hmrOptions && hmrServer) {
          await hmrServer.stop();
          // $FlowFixMe[prop-missing]
          hmrServers.delete(hmrServer.wss.options.port);
        }
        break;
      case 'buildStart':
        if (server) {
          server.buildStart();
        }
        nodeRunner?.buildStart();
        break;
      case 'buildProgress':
        if (
          event.phase === 'bundled' &&
          hmrServer &&
          // Only send HMR updates before packaging if the built in dev server is used to ensure that
          // no stale bundles are served. Otherwise emit it for 'buildSuccess'.
          options.serveOptions !== false
        ) {
          let update = await hmrServer.getUpdate(event);
          if (update) {
            // If running in node, wait for the server to update before emitting the update
            // on the client. This ensures that when the client reloads the server is ready.
            if (nodeRunner) {
              // Don't await here because that blocks the build from continuing
              // and we may need to wait for the buildSuccess event.
              let hmr = hmrServer;
              nodeRunner.emitUpdate(update).then(() => hmr.broadcast(update));
            } else {
              hmrServer.broadcast(update);
            }
          }
        }
        break;
      case 'buildSuccess': {
        if (serveOptions) {
          if (!server) {
            return logger.warn({
              message:
                'Could not send success event to devserver because it does not exist.',
            });
          }

          server.buildSuccess(event.bundleGraph, event.requestBundle);
        }
        if (hmrServer && options.serveOptions === false) {
          let update = await hmrServer.getUpdate(event);
          if (update) {
            hmrServer.broadcast(update);
          }
        }

        if (!nodeRunner && options.serveOptions) {
          nodeRunner = new NodeRunner({logger, hmr: !!options.hmrOptions});
          nodeRunners.set(options.instanceId, nodeRunner);
        }
        nodeRunner?.buildSuccess(event.bundleGraph);
        break;
      }
      case 'buildFailure':
        // On buildFailure watchStart sometimes has not been called yet
        // do not throw an additional warning here
        if (server) {
          await server.buildError(options, event.diagnostics);
        }
        if (hmrServer) {
          await hmrServer.emitError(options, event.diagnostics);
        }
        break;
    }
  },
}): Reporter);
