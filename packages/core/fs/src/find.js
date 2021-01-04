// @flow
import type {FilePath} from '@parcel/types';
import type {FileSystem} from './types';
import path from 'path';

export function findNodeModule(
  fs: FileSystem,
  moduleName: string,
  dir: FilePath,
): ?FilePath {
  let {root} = path.parse(dir);
  while (dir !== root) {
    // Skip node_modules directories
    if (path.basename(dir) === 'node_modules') {
      dir = path.dirname(dir);
    }

    try {
      let moduleDir = path.join(dir, 'node_modules', moduleName);
      let stats = fs.statSync(moduleDir);
      if (stats.isDirectory()) {
        return moduleDir;
      }
    } catch (err) {
      // ignore
    }

    // Move up a directory
    dir = path.dirname(dir);
  }

  return null;
}

const fileExistsMap = new Map<FilePath, boolean>();

export function findAncestorFile(
  fs: FileSystem,
  fileNames: Array<string>,
  dir: FilePath,
): ?FilePath {
  let {root} = path.parse(dir);
  while (dir !== root) {
    if (path.basename(dir) === 'node_modules') {
      return null;
    }

    for (const fileName of fileNames) {
      let filePath = path.join(dir, fileName);
      if (fileExistsMap.get(filePath)) return filePath;
      try {
        if (fs.statSync(filePath).isFile()) {
          fileExistsMap.set(filePath, true);
          return filePath;
        }
      } catch {
        fileExistsMap.set(filePath, false);
      }
    }

    dir = path.dirname(dir);
  }

  return null;
}

export function clearFileExistsMap() {
  fileExistsMap.clear();
}

export function findFirstFile(
  fs: FileSystem,
  filePaths: Array<FilePath>,
): ?FilePath {
  for (let filePath of filePaths) {
    try {
      if (fs.statSync(filePath).isFile()) {
        return filePath;
      }
    } catch (err) {
      // ignore
    }
  }
}
