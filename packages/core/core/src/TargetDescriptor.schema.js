// @flow strict-local
import type {SchemaEntity} from '@parcel/utils';

export const engines: SchemaEntity = {
  type: 'object',
  properties: {
    browsers: {
      oneOf: [
        {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        {
          type: 'string'
        }
      ]
    },
    node: {
      oneOf: [
        {
          type: 'array'
        },
        {
          type: 'string'
        }
      ]
    },
    electron: {
      type: 'string'
    },
    parcel: {
      type: 'string'
    },
    npm: {
      type: 'string'
    }
  },
  additionalProperties: false
};

export default ({
  type: 'object',
  properties: {
    context: {
      type: 'string',
      enum: [
        'node',
        'browser',
        'web-worker',
        'electron-main',
        'electron-renderer'
      ]
    },
    includeNodeModules: {
      oneOf: [
        {
          type: 'boolean'
        },
        {
          type: 'array',
          items: {
            type: 'string',
            __pattern: 'a wildcard or filepath'
          }
        }
      ]
    },
    outputFormat: {
      type: 'string',
      enum: ['global', 'esmodule', 'commonjs']
    },
    distDir: {
      type: 'string'
    },
    publicUrl: {
      type: 'string'
    },
    isLibrary: {
      type: 'boolean'
    },
    sourceMap: {
      oneOf: [
        {
          type: 'boolean'
        },
        {
          type: 'object',
          properties: {
            inlineSources: {
              type: 'boolean'
            },
            sourceRoot: {
              type: 'string'
            },
            inline: {
              type: 'boolean'
            }
          },
          additionalProperties: false
        }
      ]
    },
    engines
  },
  additionalProperties: false
}: SchemaEntity);
