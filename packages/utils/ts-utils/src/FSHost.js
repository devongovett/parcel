// @flow
import type {FileSystem} from '@parcel/fs';
import type {FilePath} from '@parcel/types';
import typeof TypeScriptModule from 'typescript'; // eslint-disable-line import/no-extraneous-dependencies
import path from 'path';

export class FSHost {
  fs: FileSystem;
  ts: TypeScriptModule;

  constructor(fs: FileSystem, ts: TypeScriptModule) {
    this.fs = fs;
    this.ts = ts;
  }

  getCurrentDirectory: () => FilePath = () => {
    return this.fs.cwd();
  };

  fileExists(filePath: FilePath): boolean {
    try {
      return this.fs.statSync(filePath).isFile();
    } catch (err) {
      return false;
    }
  }

  readFile(filePath: FilePath): void | string {
    try {
      return this.fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return undefined;
      }

      throw err;
    }
  }

  directoryExists(filePath: FilePath): boolean {
    try {
      return this.fs.statSync(filePath).isDirectory();
    } catch (err) {
      return false;
    }
  }

  realpath(filePath: FilePath): FilePath {
    try {
      return this.fs.realpathSync(filePath);
    } catch (err) {
      return filePath;
    }
  }

  getAccessibleFileSystemEntries(dirPath: FilePath): {|
    directories: Array<FilePath>,
    files: Array<FilePath>,
  |} {
    try {
      let entries = this.fs.readdirSync(dirPath || '.').sort();
      let files = [];
      let directories = [];
      for (let entry of entries) {
        let filePath = path.join(dirPath, entry);

        let stat;
        try {
          stat = this.fs.statSync(filePath);
        } catch (e) {
          continue;
        }

        if (stat.isFile()) {
          files.push(entry);
        } else if (stat.isDirectory()) {
          directories.push(entry);
        }
      }

      return {files, directories};
    } catch (err) {
      return {files: [], directories: []};
    }
  }

  readDirectory(
    root: FilePath,
    extensions?: $ReadOnlyArray<string>,
    excludes?: $ReadOnlyArray<string>,
    includes?: $ReadOnlyArray<string>,
    depth?: number,
  ): any {
    // $FlowFixMe[prop-missing]
    return this.ts.matchFiles(
      root,
      extensions,
      excludes,
      includes,
      this.ts.sys.useCaseSensitiveFileNames,
      this.getCurrentDirectory(),
      depth,
      dirPath => this.getAccessibleFileSystemEntries(dirPath),
      filePath => this.realpath(filePath),
      dirPath => this.directoryExists(dirPath),
    );
  }

  getDirectories(filePath: FilePath): Array<FilePath> {
    return this.ts.sys.getDirectories(filePath);
  }
}
