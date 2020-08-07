import GTA5Dashlet from './Dashlet';
import InstallDialog, { IOptions, IInstallerDialogState } from './InstallDialog';
import OIV from './oiv';
import { isOIVInstalled, openIVPath } from './util';

import * as Promise from 'bluebird';
import getExeVersion from 'exe-version';
import * as path from 'path';
import turbowalk from 'turbowalk';
import { actions, fs, log, util, types, selectors } from 'vortex-api';

const GAME_ID = 'gta5';
const RPF_PATH = path.join('update', 'x64', 'dlcpacks', 'vortex', 'dlc.rpf');
const SCRIPTHOOK_URL = 'http://www.dev-c.com/gtav/scripthookv/';

const getNameMap = (() => {
  let result: { [key: string]: string[] };

  return () => {
    if (result === undefined) {
      result = JSON.parse(fs.readFileSync(path.join(__dirname, 'namemap.json'), { encoding: 'utf-8' }));
    }
    return result;
  };
})();

const getAssetExts = (() => {
  let result: string[];

  return () => {
    if (result === undefined) {
      result = Array.from(new Set(Object.keys(getNameMap())
        .map(fileName => path.extname(fileName))))
        .filter(fileExt => ['', '.txt'].indexOf(fileExt) === -1);
    }

    return result;
  }
})();

function findGame(): Promise<string> {
  return util.GameStoreHelper.findByName(['Grand Theft Auto V'])
      .then(game => game.gamePath);
}

function modPath(): string {
  return path.join('mods', 'source', 'content');
}

function prepareForModding(discovery: types.IDiscoveryResult): Promise<void> {
  return fs.ensureDirWritableAsync(path.join(discovery.path, modPath()), () => Promise.resolve())
    .then(() => fs.ensureDirWritableAsync(
      path.join(discovery.path, 'mods', 'update', 'x64', 'dlcpacks'), () => Promise.resolve()))
    .then(() => undefined);
}

function toPromise<T>(func: (cb: (err: Error, res: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cb = (err: Error, res: T) => {
      if (err !== null) {
        reject(err);
      } else {
        resolve(res);
      }
    };
    func(cb);
  });
}

function openIVTool(state: types.IState): types.IDiscoveredTool {
  const tools: { [id: string]: any } = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', 'gta5', 'tools'], {});

  return Object.keys(tools).map(id => tools[id])
    .filter(iter => (iter !== undefined) && (iter.path !== undefined))
    .find(iter => path.basename(iter.path).toLowerCase() === 'openiv.exe');
}

function runOpenIV(api: types.IExtensionApi, args: string[]): Promise<void> {
  const state: types.IState = api.store.getState();

  const tool: types.IDiscoveredTool = openIVTool(state);
  if (tool === undefined) {
    return Promise.reject(new util.SetupError('OpenIV not installed or not configured correctly'));
  }

  // unfortunately the order of parameters to openiv matters, we have to put .oiv files before
  // "-core:<game name>" for it to work
  return api.runExecutable(tool.path, [].concat(args, tool.parameters), { suggestDeploy: false });
}

// check that ScriptHookV is installed
function genCheckScriptHookV(api: types.IExtensionApi) {
  return (): Promise<types.ITestResult> => {
    const state = api.store.getState();
    const gameMode = selectors.activeGameId(state);
    if (gameMode !== GAME_ID) {
      return Promise.resolve(undefined);
    }

    const discovery = selectors.discoveryByGame(state, GAME_ID)
    if ((discovery === undefined) || (discovery.path === undefined)) {
      return Promise.resolve(undefined);
    }

    const gtaVer = getExeVersion(path.join(discovery.path, 'GTA5.exe'));
    let hookVer: string;
    try {
      hookVer = getExeVersion(path.join(discovery.path, 'ScriptHookV.dll'));
    } catch (err) {
      // nop
    }

    if (hookVer !== gtaVer) {
      const result: types.ITestResult = {
        description: {
          short: hookVer === undefined
            ? 'ScriptHookV is missing'
            : 'ScriptHookV is outdated',
          long: hookVer === undefined
            ? 'ScriptHookV is missing. This is required for many mods.'
            : 'ScriptHookV is outdated. The game is version {{gtaVer}}, '
              + 'the hook version {{hookVer}} ',
          replace: {
            gtaVer,
            hookVer,
          }
        },
        severity: 'warning',
        automaticFix: () => {
          // update the hook version because the user might have updated/deployed
          // in the meantime
          try {
            hookVer = getExeVersion(path.join(discovery.path, 'ScriptHookV.dll'));
          } catch (err) {
            // nop
          }
          return (hookVer === gtaVer)
          ? Promise.resolve()
          : api.emitAndAwait('browse-for-download', SCRIPTHOOK_URL,
            'Download the latest version')
            .then((urls: string[]) => (!!urls && (urls.length > 0))
              ? toPromise<string>(cb => {
                urls = urls.map(url => url.includes('<') ? url : url + '<' + SCRIPTHOOK_URL);
                api.events.emit('start-download', urls, {}, undefined, cb);
              })
                .catch((err: Error) => (err.name === 'DownloadIsHTML')
                    ? Promise.reject(new util.ProcessCanceled('User didn\'t select a download'))
                    : Promise.reject(err))
              : Promise.reject(new util.UserCanceled()))
            .then((dlId: string) => toPromise(cb => api.events.emit('start-install-download', dlId, true, cb)))
            .then((modId: string) => {
              const profile = selectors.activeProfile(api.store.getState());
              api.store.dispatch(actions.setModType(GAME_ID, modId, 'gta5asi'));
              api.store.dispatch(actions.setModEnabled(profile.id, modId, true));
              return toPromise(cb => api.events.emit('deploy-mods', cb));
            });
          },
      };
      return Promise.resolve(result);
    }

    return Promise.resolve(undefined);
  };
}

// check that OpenIV is installed
function genCheckOpenIV(api: types.IExtensionApi) {
  return (): Promise<types.ITestResult> => {
    {
      const state = api.store.getState();
      const gameMode = selectors.activeGameId(state);
      if (gameMode !== GAME_ID) {
        return Promise.resolve(undefined);
      }
    }

    return isOIVInstalled()
      .then(installed => {
        if (installed) {
          return Promise.resolve(undefined);
        }
        const result: types.ITestResult = {
          description: {
            short: 'OpenIV is missing',
            long: 'OpenIV is required to install any mods. You can install mods now but they won\'t have any '
                + 'effect without it. OpenIV is a stand alone application that has no affiliation with '
                + 'Nexus Mods.',
          },
          severity: 'warning',
          automaticFix: () =>
            (api.emitAndAwait as any)('browse-for-download', 'https://openiv.com')
              .then((url: string[]) => ((url !== undefined) && (url.length > 0))
                ? toPromise(cb => api.events.emit('start-download', url, {}, undefined, cb))
                  .catch((err: Error) => (err.name === 'DownloadIsHTML')
                      ? Promise.reject(new util.ProcessCanceled('User didn\'t select a download'))
                      : Promise.reject(err))
                : Promise.reject(new util.UserCanceled()))
              .then((dlId: string) => {
                const state: types.IState = api.store.getState();
                const download = state.persistent.downloads.files[dlId];
                if (download === undefined) {
                  return Promise.reject(new Error('OpenIV download failed'));
                }

                return api.showDialog('info', 'OpenIV downloaded', {
                  text: 'OpenIV is a stand alone application that can not be installed as a mod within Vortex. '
                    + 'When you press continue the OpenIV installer will be started, please follow its instructions.',
                }, [
                  { label: 'Cancel' },
                  { label: 'Continue' },
                ])
                  .then((result: types.IDialogResult) => {
                    if (result.action === 'Continue') {
                      return util.opn(path.join(selectors.downloadPathForGame(state, GAME_ID), download.localPath), true)
                        .catch(() => Promise.resolve(undefined));
                    } else {
                      return Promise.resolve(undefined);
                    }
                  });
              })
        };
        return Promise.resolve(result);
      });
  }
}

// check that OpenIV.asi is installed
function genCheckOpenIVASI(api: types.IExtensionApi) {
  return (): Promise<types.ITestResult> => {
    const state = api.store.getState();
    const gameMode = selectors.activeGameId(state);
    if (gameMode !== GAME_ID) {
      return Promise.resolve(undefined);
    }

    const discovery = selectors.discoveryByGame(state, GAME_ID)
    if ((discovery === undefined) || (discovery.path === undefined)) {
      return Promise.resolve(undefined);
    }

    return fs.statAsync(path.join(discovery.path, 'OpenIV.asi'))
      .then(() => Promise.resolve(undefined))
      .catch({ code: 'ENOENT' }, err => {
        const result: types.ITestResult = {
          description: {
            short: 'OpenIV.asi is missing',
            long: 'OpenIV.asi allows us to install mods without having to modify the original game files. '
                + 'It\'s part of OpenIV but has to be installed separately using its ASI Manager (under Tools).',
          },
          severity: 'warning',
          automaticFix: () => {
            return fs.statAsync(openIVPath())
              .then(() => runOpenIV(api, []))
              .catch(() => api.showDialog('info', 'OpenIV not installed', {
                text: 'You have to install OpenIV first.',
              }, [
                { label: 'Close' },
              ]))
              .then(() => null);
          },
        };
        return Promise.resolve(result);
      })
      .catch(util.ProcessCanceled, () => null);
  };
}

function makeGetASIPath(api: types.IExtensionApi) {
  return (game: types.IGame) => {
    const state: types.IState = api.store.getState();
    const discovery = state.settings.gameMode.discovered[game.id];
    if (discovery !== undefined) {
      return discovery.path;
    } else {
      return undefined;
    }
  };
}

function makeTestASI(api: types.IExtensionApi) {
  const ext = input => path.extname(input).toLowerCase();
  return (installInstructions: types.IInstruction[]): Promise<boolean> => {
    const assetExts = getAssetExts();
    const hasASI = installInstructions.find(iter =>
      !!iter.destination
      && (ext(iter.destination) === '.asi')) !== undefined;
    const hasAssets = installInstructions.find(iter =>
      !!iter.destination
      && ((assetExts.indexOf(ext(iter.destination)) !== -1)
          || (ext(iter.destination) === '.rpf'))) !== undefined;
    return Promise.resolve(hasASI && !hasAssets);
  };
}

function makeGetDLCPath(api: types.IExtensionApi) {
  return (game: types.IGame) => {
    const state: types.IState = api.store.getState();
    const discovery = state.settings.gameMode.discovered[game.id];
    if (discovery !== undefined) {
      return path.join(discovery.path, 'mods', 'update', 'x64', 'dlcpacks');
    } else {
      return undefined;
    }
  };
}

function makeTestDLC(api: types.IExtensionApi) {
  return (installInstructions: types.IInstruction[]): Promise<boolean> => {
    const hasDLC = installInstructions.find(iter =>
      !!iter.destination
      && (path.basename(iter.destination).toLowerCase() === 'dlc.rpf')) !== undefined;
    return Promise.resolve(hasDLC);
  };
}

function replacerTest(files: string[], gameId: string): Promise<types.ISupportedResult> {
  let supported = gameId === GAME_ID;

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

interface IAmbiguousDestination {
  source: string;
  destination: string[];
}

interface IAmbiguousSource {
  source: string[];
  destination: string;
}

const installerState = util.makeReactive<IInstallerDialogState>({
  options: [],
  text: '',
  labelKey: '',
  labelChoices: '',
  callback: undefined,
});

function invokeDialog(options: IOptions,
                      text: string,
                      labelKey: string,
                      labelChoices: string)
                      : Promise<Array<{ key: string, choice: string }>> {
  return new Promise((resolve, reject) => {
    installerState.options = options;
    installerState.text = text;
    installerState.labelKey = labelKey;
    installerState.labelChoices = labelChoices;
    installerState.callback = (err: Error, result: Array<{ key: string, choice: string }>) => {
      installerState.callback = undefined;
      if (err !== null) {
        reject(err);
      } else {
        resolve(result);
      }
    }
  });
}

function disambiguateDestination(input: IAmbiguousDestination[]): Promise<Array<{ source: string, destination: string }>> {
  const { ambiguous, clear }: { ambiguous: IAmbiguousDestination[], clear: IAmbiguousDestination[] } =
    input.reduce((prev, iter) => {
      prev[iter.destination.length > 1 ? 'ambiguous' : 'clear'].push(iter);
      return prev;
    }, { ambiguous: [], clear: [] });

  if (ambiguous.length === 0) {
    return Promise.resolve(clear.map(iter => ({ source: iter.source, destination: iter.destination[0] })));
  }

  return invokeDialog(
    ambiguous.map((iter) => ({ key: iter.source, options: iter.destination })),
    'It\'s unclear where these files should be installed, there are multiple options.',
    'Source',
    'Destination',
  ).map(iter => ({ source: iter.key, destination: iter.choice }))
  .then(choices => [].concat(choices, clear.map(iter => ({ source: iter.source, destination: iter.destination[0] }))));
}

function disambiguateSource(input: IAmbiguousSource[]): Promise<Array<{ source: string, destination: string }>> {
  const { ambiguous, clear }: { ambiguous: IAmbiguousSource[], clear: IAmbiguousSource[] } =
    input.reduce((prev, iter) => {
      prev[iter.source.length > 1 ? 'ambiguous' : 'clear'].push(iter);
      return prev;
    }, { ambiguous: [], clear: [] });

  if (ambiguous.length === 0) {
    return Promise.resolve(clear.map(iter => ({ source: iter.source[0], destination: iter.destination })));
  }

  return invokeDialog(
    ambiguous.map((iter) => ({ key: iter.destination, options: iter.source })),
    'Multiple files would be installed to the same destination, you have to pick which to keep.',
    'Destination',
    'Source',
  ).map(iter => ({ destination: iter.key, source: iter.choice }))
  .then(choices => [].concat(choices, clear.map(iter => ({ source: iter.source[0], destination: iter.destination }))));
}

function disambiguateInstall(input: IAmbiguousDestination[]): Promise<types.IInstruction[]> {
  const group = (input: Array<{ source: string, destination: string }>) => {
    const mapped = input.reduce((prev, iter) => {
      if (prev[iter.destination] === undefined) {
        prev[iter.destination] = [];
      }
      prev[iter.destination].push(iter.source);
      return prev;
    }, {});
    return Object.keys(mapped).map(destination => ({ source: mapped[destination], destination }));
  }

  return disambiguateDestination(input)
    .then((choices: Array<{ source: string, destination: string }>) => disambiguateSource(group(choices)))
    .then((choices: Array<{ source: string, destination: string }>) => 
      choices.map(iter => ({ ...iter, type: 'copy' })));
}

/**
 * This installer restructures mods containing replacement for 
 */
function replacerInstaller(files: string[]): Promise<types.IInstallResult> {
  const copies: IAmbiguousDestination[] =  files
    .filter(filePath => !filePath.endsWith(path.sep))
    .map(filePath => {
      const fileName = path.basename(filePath);
      const knownFiles = getNameMap()[fileName];
      if (knownFiles !== undefined) {
        // replacer for a known file
        return {
          source: filePath,
          destination: knownFiles,
        }
      } else if ((['.dll', '.asi'].indexOf(path.extname(fileName)) !== -1)
                 || (fileName === 'dlc.rpf')) {
        // pull all script hooks and dlcs to the root (of their respective
        // install location)
        return {
          source: filePath,
          destination: [fileName],
        };
      } else {
        return {
          source: filePath,
          destination: [filePath],
        };
      };
    });

  return disambiguateInstall(copies)
    .then(instructions => ({
      instructions,
    }));
}

function mergeTest(game: types.IGame) {
  if (game.id !== GAME_ID) {
    return undefined;
  }

  return {
    baseFiles: () => [
      {
        in: path.join(__dirname, 'assembly.xml'),
        out: path.join('assembly.xml'),
      },
    ],
    filter: filePath => ['.oiv', '.rpf'].indexOf(path.extname(filePath).toLowerCase()) !== -1
                     || getAssetExts().indexOf(path.extname(filePath).toLowerCase()) !== -1,
  };
}

function isLatin1(input: string): boolean {
  for (let i = 0; i < input.length; ++i) {
    if (input.charCodeAt(i) > 255) {
      return false;
    }
  }
  return true;
}

function merge(filePath: string, mergeDir: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const mergePath = path.join(mergeDir, 'assembly.xml');
  return Promise.resolve(OIV.fromFile(mergePath, { rpfVersion: 'RPF7' }))
    .then(oiv => {
      let prom = Promise.resolve();
      if (ext === '.oiv') {
        const modName = path.basename(filePath);
        const tempPath = path.join(mergeDir, modName);
        const sZip = new (util as any).SevenZip();
        prom = sZip.extractFull(filePath, tempPath, { ssc: false },
          () => null,
          () => Promise.reject(new util.ProcessCanceled('oiv password protected?')))
          .then(() => oiv.merge(tempPath, path.join(modName, 'content')));
      } else if (ext === '.rpf') {
        oiv.addDLC(path.basename(path.dirname(filePath)));
      } else {
        if (!isLatin1(filePath)) {
          // hopefully this is only a readme or something
          log('warn', 'File not included in vortex.oiv because OpenIV wouldn\'t support it', filePath);
          return;
        }
        const basePath = path.dirname(mergeDir);
        const relPath = path.relative(basePath, filePath);
        const split = relPath.split(path.sep);
        split[0] = sanitize(split[0]);
        let rpfName = RPF_PATH;
        let rpfIdx = split.findIndex(seg => path.extname(seg) === '.rpf');
        if (rpfIdx !== -1) {
          rpfName = split.slice(1, rpfIdx + 1).join(path.sep);
          ++rpfIdx;
        } else {
          rpfIdx = 1;
        }
        oiv.addFile(split.join(path.sep), split.slice(rpfIdx).join(path.sep), rpfName);
      }
      return prom.then(() => oiv.save(mergePath));
    });
}

function sanitize(input: string): string {
  return input.replace(/[._\- ]/g, '');
}

function deploymentGate(api: types.IExtensionApi): Promise<void> {
  return new Promise((resolve, reject) => {
    api.sendNotification({
      type: 'info',
      message: 'You have to deploy before you play the game',
      noDismiss: true,
      actions: [{
        title: 'Deploy now',
        action: dismiss => { dismiss(); resolve(); },
      }, {
        title: 'Later',
        action: dismiss => {
          dismiss();
          reject(new util.UserCanceled());
          api.store.dispatch(actions.setDeploymentNecessary(GAME_ID, true));
        },
      }],
    });
  });
}

/**
 * clean out everything in the mods directory except for the files deployed for
 * the default mod type.
 * This is to ensure the game rpfs are reset so we don't carry over changes from
 * previous deployments.
 * TODO: currently this also deletes the dlc.rpfs from the gta5dlc mod type.
 *   they will just get redeployed though so no biggy
 */
function cleanMods(discovery: types.IDiscoveryResult, whitelist: Set<string>): Promise<void> {
  const basePath = path.join(discovery.path, 'mods');
  const toRemove: string[] = [];
  return turbowalk(basePath, entries => {
    toRemove.push(...entries
      .filter(iter => {
        const fileName = path.basename(iter.filePath);
        return !iter.isDirectory
          && !fileName.startsWith('__')
          && !whitelist.has(fileName);
      })
      .map(iter => iter.filePath));
  })
  .then(() => Promise.map(toRemove, filePath => fs.removeAsync(filePath)))
  // if the mods path is not found that's fine, nothing to clean up in that case
  .catch({ code: 'ENOTFOUND' }, () => null)
  .then(() => prepareForModding(discovery));
}

/**
 * remove the oivs that were extracted so we could merge them into the master oiv
 */
function removeTempOIVs(discovery: types.IDiscoveryResult): Promise<void> {
  const basePath = path.join(discovery.path, 'mods', 'source');
  return fs.readdirAsync(basePath)
    .filter((fileName: string) => {
      if (path.extname(fileName) !== '.oiv') {
        return Promise.resolve(false);
      } else {
        return fs.statAsync(path.join(basePath, fileName)).then(stats => stats.isDirectory());
      }
    })
    .then((files: string[]) =>
      Promise.map(files, fileName => fs.removeAsync(path.join(basePath, fileName))))
    .then(() => Promise.resolve());
}

function genPreDeploy(api: types.IExtensionApi) {
  return (profileId: string, lastDeployment: { [typeId: string]: types.IDeployedFile[] }) => {
    const state = api.store.getState();

    const profile: types.IProfile = selectors.profileById(state, profileId);
    if (profile.gameId !== GAME_ID) {
      return Promise.resolve();
    }

    const discovery: types.IDiscoveryResult = selectors.discoveryByGame(state, GAME_ID);
    if ((discovery === undefined) || (discovery.path === undefined)) {
      // this check shouldn't be necessary but whatevs...
      return Promise.resolve();
    }

    // list of files we deployed
    const whiteList = new Set<string>([].concat(...Object.values(lastDeployment))
      .map((entry: types.IDeployedFile) => path.basename(entry.relPath)));

    // clean the entire output directory to ensure the rpfs that openiv copied over get reset
    return cleanMods(discovery, whiteList)
      .catch(util.UserCanceled, () => null)
      .catch(err => {
        log('error', 'failed to clean gtav mods', { error: err.message });
      });
  };
}

function genPostDeploy(api: types.IExtensionApi) {
  return (profileId: string, deployment: any, progress: (title: string) => void) => {
    const state = api.store.getState();

    const profile: types.IProfile = selectors.profileById(state, profileId);
    if (profile.gameId !== GAME_ID) {
      return Promise.resolve();
    }

    const discovery: types.IDiscoveryResult = selectors.discoveryByGame(state, GAME_ID);
    if ((discovery === undefined) || (discovery.path === undefined)) {
      // this check shouldn't be necessary but whatevs...
      return Promise.resolve();
    }

    // package content and xml file into the vortex.oiv
    const sZip = new (util as any).SevenZip();
    const basePath = path.join(discovery.path, 'mods', 'source');
    const assemblyPath = path.join(basePath, 'content', 'assembly.xml');
    // wrap up the assembly.xml file
    return isOIVInstalled()
      .then(installed => {
        if (!installed) {
          return Promise.resolve();
        }
        return Promise.resolve(OIV.fromFile(assemblyPath, { rpfVersion: 'RPF7' }))
          .catch({ code: 'ENOENT' }, () => Promise.reject(new util.ProcessCanceled('nothing to deploy')))
          .then(oiv => {
            const dlcpacksPath = path.join(discovery.path, 'mods', 'update', 'x64', 'dlcpacks');
            return fs.readdirAsync(dlcpacksPath)
              .filter(dlcPath => {
                if (dlcPath === 'vortex') {
                  return Promise.resolve(false);
                }
                return fs.statAsync(path.join(dlcpacksPath, dlcPath)).then(stat => stat.isDirectory());
              })
              .then(dlcPaths => {
                dlcPaths.forEach(dlcPath => oiv.addDLC(dlcPath));
                oiv.addFile('frontend.ytd', path.join('x64', 'textures', 'frontend.ytd'), path.join('update', 'update.rpf'));
              })
              .then(() => oiv.save(assemblyPath));
          })
          .then(() => fs.copyAsync(path.join(__dirname, 'content', 'frontend.ytd'),
            path.join(discovery.path, modPath(), 'frontend.ytd')))
          .then(() => sZip.add(path.join(discovery.path, modPath(), 'vortex.oiv.zip'), [
            assemblyPath,
            path.join(__dirname, 'content'),
            path.join(__dirname, 'vortex.png'),
          ]))
          .then(() => sZip.update(path.join(discovery.path, modPath(), 'vortex.oiv.zip'), [
            path.join(basePath, 'content'),
          ]))
          .then(() => fs.renameAsync(path.join(discovery.path, modPath(), 'vortex.oiv.zip'),
            path.join(discovery.path, modPath(), 'vortex.oiv')))
          .then(() => api.showDialog('info', 'Need to run OpenIV', {
            bbcode: 'To complete deployment we have to to run OpenIV to import assets, this will take a bit.<br/>'
              + 'This imports all mods at once so you don\'t have to do it for every mod you install!<br/>'
              + 'During the install, please make sure you choose the option to install to the "mods" folder, '
              + 'do [b]not[/b] install to the game folder.',
          }, [
            { label: 'Cancel' },
            { label: 'Continue' },
          ]))
          .then((result: types.IDialogResult) => (result.action === 'Continue')
            ? removeTempOIVs(discovery)
              .then(() => runOpenIV(api, [path.join(discovery.path, modPath(), 'vortex.oiv')]))
            : Promise.reject(new util.UserCanceled()))
          .catch(util.SetupError, () => {
            api.showErrorNotification('OpenIV not set up',
              'To deploy mods OpenIV has to be installed and set up correctly as a tool in the dashboard. '
              + 'Please check that you can run OpenIV from the dashboard and then try again.',
              { allowReport: false });
          })
          .catch(util.UserCanceled, () => Promise.resolve(undefined))
          .catch(util.ProcessCanceled, () => Promise.resolve(undefined));
      });
    };
}

function main(context: types.IExtensionContext) {
  context.registerGame({
    id: GAME_ID,
    name: 'Grand Theft Auto V',
    mergeMods: mod => sanitize(mod.id),
    queryPath: findGame,
    queryModPath: modPath,
    logo: 'gameart.png',
    executable: () => 'PlayGTAV.exe',
    parameters: [
      '-scOfflineOnly',
    ],
    requiredFiles: [
      'GTA5.exe'
    ],
    supportedTools: [
      {
        id: 'OpenIV',
        name: 'OpenIV',
        executable: () => 'OpenIV.exe',
        parameters: ['-core.game:Five'],
        queryPath: () => openIVPath(),
        requiredFiles: [
          'OpenIV.exe',
          'Core.xml',
        ],
      },
    ],
    setup: prepareForModding,
    details: {
      steamAppId: 271590,
      stopPatterns: ['[^/]*\\.rpf', '[^/]*\\.asi'],
      supportsSymlinks: false,
    },
    compatible: {
      symlinks: false,
      usvfs: false,
    },
    deploymentGate: () => deploymentGate(context.api),
  } as any);

  // verify scripthook and openiv are installed and up-to-date
  context.registerTest('scripthookv-current', 'gamemode-activated',
                       genCheckScriptHookV(context.api));
  context.registerTest('openiv', 'gamemode-activated',
                       genCheckOpenIV(context.api));
  context.registerTest('openivasi', 'gamemode-activated',
                       genCheckOpenIVASI(context.api));

  context.registerDialog('gta5install', InstallDialog, () => ({
    state: installerState,
  }));

  // install asi mods to the game base directory
  (context.registerModType as any)('gta5asi', 25, gameId => gameId === GAME_ID,
                                   makeGetASIPath(context.api), makeTestASI(context.api), {
    mergeMods: true,
  });

  context.registerModType('gta5dlc', 25, gameId => gameId === GAME_ID,
                          makeGetDLCPath(context.api), makeTestDLC(context.api));

  // offer gta5-mods as a source for downloads
  (context.registerModSource as any)('gta5mods', 'GTA 5 Mods', () => {
    context.api.store.dispatch((actions as any).showURL('https://gta5-mods.com'));
  }, {
    condition: () => selectors.activeGameId(context.api.store.getState()) === GAME_ID,
    icon: '5mods',
  });

  // display a warning about using mods online to the dashboard
  context.registerDashlet('Grand Theft Auto V', 2, 2, 0, GTA5Dashlet,
    (state: types.IState) => selectors.activeGameId(state) === GAME_ID,
    () => ({}),
    {});

  context.registerMerge(mergeTest, merge, '');

  context.registerInstaller('gta5-mod', 25, replacerTest, replacerInstaller);

  context.once(() => {
    context.api.onAsync('will-deploy', genPreDeploy(context.api));
    context.api.onAsync('did-deploy', genPostDeploy(context.api));

    context.api.setStylesheet('gta5', path.join(__dirname, 'style.scss'));
    util.installIconSet('gta5-icons', path.join(__dirname, '5mods.svg'))
      .catch(err => {
        log('error', 'failed to load icon set', { error: err.message });
      });
  });

  return true;
}

export default main;
