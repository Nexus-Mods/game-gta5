import * as Promise from 'bluebird';
import * as path from 'path';
import { fs, util } from 'vortex-api';

const localAppData: () => string = (() => {
  let cached: string;
  return () => {
    if (cached === undefined) {
      cached = process.env.LOCALAPPDATA
        || path.resolve(util.getVortexPath('appData'), '..', 'Local');
    }
    return cached;
  };
})();

export function openIVPath(): string {
  return path.join(localAppData(), 'New Technology Studio', 'Apps', 'OpenIV');
}

export function isOIVInstalled(): Promise<boolean> {
  return fs.statAsync(openIVPath())
    .then(() => true)
    .catch(() => false);
}
