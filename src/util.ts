import * as Promise from 'bluebird';
import * as path from 'path';
import { fs } from 'vortex-api';

export function openIVPath(): string {
  return path.join(process.env.LOCALAPPDATA, 'New Technology Studio', 'Apps', 'OpenIV');
}

export function isOIVInstalled(): Promise<boolean> {
  return fs.statAsync(openIVPath())
    .then(() => true)
    .catch(() => false);
}
