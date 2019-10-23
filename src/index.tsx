import GTA5Dashlet from './Dashlet';
import OIV from './oiv';

import * as Promise from 'bluebird';
import getExeVersion from 'exe-version';
import { actions, fs, log, util, types, selectors } from 'vortex-api';
import * as path from 'path';

const GAME_ID = 'gta5';
const RPF_PATH = path.join('update', 'x64', 'dlcpacks', 'vortex', 'dlc.rpf');

const getNameMap = (() => {
  let result: { [key: string]: string[] };

  return () => {
    if (result === undefined) {
      result = JSON.parse(fs.readFileSync(path.join(__dirname, 'namemap.json')));
    }
    return result;
  };

})();

const getAssetExts = (() => {
  let result: string[];

  return () => {
    if (result === undefined) {
      result = Array.from(new Set(Object.keys(getNameMap()).map(fileName => path.extname(fileName))));
    }

    return result;
  }
})();

function findGame(): Promise<string> {
  return util.steam.findByName('Grand Theft Auto V')
      .then(game => game.gamePath);
}

function modPath(): string {
  return path.join('mods', 'source', 'content');
  // return path.join('mods', 'update', 'x64', 'dlcpacks');
}

function openIVPath(): string {
  return path.join(process.env.LOCALAPPDATA, 'New Technology Studio', 'Apps', 'OpenIV');
}

const BASE_RDFS = [
/*
  'common.rpf',
  'x64e.rpf',
  'update\\update.rpf',
  'x64\\audio\\sfx\\SCRIPT.rpf',
  'update\\x64\\dlcpacks\\mpheist\\dlc.rpf',
*/
];

function ensureCopy(basePath: string, rdfPath: string) {
  return fs.statAsync(path.join(basePath, 'mods', rdfPath))
        .then(() => Promise.resolve())
        .catch({ code: 'ENOENT' }, () =>
          fs.copyAsync(path.join(basePath, rdfPath),
                       path.join(basePath, 'mods', rdfPath)))
}

function prepareForModding(discovery: types.IDiscoveryResult): Promise<void> {
  return fs.ensureDirWritableAsync(path.join(discovery.path, modPath()),
                                   () => Promise.resolve())
    // copy the source rdf files that might be modified
    .then(() => Promise.map(BASE_RDFS, baseRDF => ensureCopy(discovery.path, baseRDF)))
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

function runOpenIV(api: types.IExtensionApi): Promise<void> {
  const state: types.IState = api.store.getState();

  const tool: types.IDiscoveredTool = openIVTool(state);
  if (tool === undefined) {
    return Promise.reject(new util.SetupError('OpenIV not installed or not configured correctly'));
  }

  return api.runExecutable(tool.path, tool.parameters, { suggestDeploy: false });
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
          short: 'ScriptHookV is missing or outdated',
          long: 'ScriptHookV is missing or outdated, this is required for many mods',
        },
        severity: 'warning',
        automaticFix: () =>
          (api.emitAndAwait as any)('browse-for-download', 'http://www.dev-c.com/gtav/scripthookv/',
            'Download the latest version')
            .then(url => toPromise<string>(cb => api.events.emit('start-download', [url], {}, undefined, cb)))
            .then((dlId: string) => toPromise(cb => api.events.emit('start-install-download', dlId, true, cb)))
            .then((modId: string) => {
              const profile = selectors.activeProfile(api.store.getState());
              api.store.dispatch(actions.setModType(GAME_ID, modId, 'gta5asi'));
              api.store.dispatch(actions.setModEnabled(profile.id, modId, true));
              return toPromise(cb => api.events.emit('deploy-mods', cb));
            }),
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

    return fs.statAsync(openIVPath())
      .then(() => undefined)
      .catch({ code: 'ENOENT' }, () => {
        const result: types.ITestResult = {
          description: {
            short: 'OpenIV is missing',
            long: 'OpenIV is required to install any mods. You can install mods now but they won\'t have any '
                + 'effect without it. OpenIV is a stand alone application that has no affiliation with '
                + 'Nexus Mods.',
          },
          severity: 'warning',
          automaticFix: () =>
            api.emitAndAwait('browse-for-download', 'https://openiv.com')
              .then(url => toPromise(cb => api.events.emit('start-download', [url], {}, undefined, cb)))
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
                      return util.opn(path.join(selectors.downloadPathForGame(GAME_ID), download.localPath), true)
                        .catch(() => undefined);
                    } else {
                      Promise.resolve();
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
      .then(() => undefined)
      .catch({ code: 'ENOENT' }, err => {
        const result: types.ITestResult = {
          description: {
            short: 'OpenIV.asi is missing',
            long: 'OpenIV.asi allows us to install mods without having to modify the original game files. '
                + 'It\'s part of OpenIV but has to be installed separately using its ASI Manager (under Tools).',
          },
          severity: 'warning',
          automaticFix: () => runOpenIV(api),
        };
        return Promise.resolve(result);
      });
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
  return (installInstructions: types.IInstruction[]): Promise<boolean> => {
    return Promise.resolve(installInstructions.find(iter =>
      path.extname(iter.destination).toLowerCase() === '.asi') !== undefined);
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
    return Promise.resolve(installInstructions.find(iter =>
      path.basename(iter.destination).toLowerCase() === 'dlc.rpf') !== undefined);
  };
}

function replacerTest(files: string[], gameId: string): Promise<types.ISupportedResult> {
  let supported = false;
  if (gameId === GAME_ID) {
    // the mod is treated as a replacer if it contains any files we recognize as part of the base archives
    supported = files.find(filePath => {
      const knownFile = getNameMap()[path.basename(filePath)];
      return knownFile !== undefined;
    }) !== undefined;
  }

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

/**
 * This installer restructures mods containing replacement for 
 */
function replacerInstaller(files: string[]): Promise<types.IInstallResult> {
  return Promise.resolve({
    instructions: files
      .filter(filePath => !filePath.endsWith(path.sep))
      .map(filePath => {
      const knownFiles = getNameMap()[path.basename(filePath)];
      if (knownFiles === undefined) {
        return {
          type: 'copy',
          source: filePath,
          destination: filePath,
        };
      }

      let knownFile = knownFiles[0];
      if (knownFiles.length > 1) {
        // TODO: Could be multiple matches...
        let knownUpdate = knownFiles.find(iter => iter.startsWith('update.rpf'));
        if (knownUpdate !== undefined) {
          knownFile = knownUpdate;
        }
        // TODO: Also, there might be multiple files, none of which is in update.rpf
        //  common case is files existing in female and male variants
      }

      return {
        type: 'copy',
        source: filePath,
        destination: knownFile,
      };
    })
  });
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

function merge(filePath: string, mergeDir: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const mergePath = path.join(mergeDir, 'assembly.xml');
  return Promise.resolve(OIV.fromFile(mergePath))
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
        //oiv.addDLC(path.basename(path.dirname(filePath)), RPF_PATH, true);
        oiv.addDLC(path.basename(path.dirname(filePath)), 'update\\update.rpf', false);
      } else {
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
        // oiv.addFile(split.join(path.sep), split.slice(1).join(path.sep), RPF_PATH);
        oiv.addFile(split.join(path.sep), split.slice(rpfIdx).join(path.sep), rpfName);
      }
      return prom.then(() => oiv.save(mergePath));
    });
}

function sanitize(input: string): string {
  return input.replace(/[._\- ]/g, '');
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
      'GTA5.exe',
      'GTAVLauncher.exe'
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
    },
  });

  // verify scripthook and openiv are installed and up-to-date
  context.registerTest('scripthookv-current', 'gamemode-activated',
                       genCheckScriptHookV(context.api));
  context.registerTest('openiv', 'gamemode-activated',
                       genCheckOpenIV(context.api));
  context.registerTest('openivasi', 'gamemode-activated',
                       genCheckOpenIVASI(context.api));

  // install asi mods to the game base directory
  (context.registerModType as any)('gta5asi', 25, gameId => gameId === GAME_ID,
                                   makeGetASIPath(context.api), makeTestASI(context.api), {
    mergeMods: true,
  });

  context.registerModType('gta5dlc', 25, gameId => gameId === GAME_ID,
                          makeGetDLCPath(context.api), makeTestDLC(context.api));

  // offer gta5-mods as a source for downloads
  context.registerModSource('gta5mods', 'GTA 5 Mods', () => {
    context.api.store.dispatch((actions as any).showURL('https://gta5-mods.com'));
  });

  // display a warning about using mods online to the dashboard
  context.registerDashlet('Grand Theft Auto V', 2, 2, 0, GTA5Dashlet,
    (state: types.IState) => selectors.activeGameId(state) === GAME_ID,
    () => ({}),
    {});

  context.registerMerge(mergeTest, merge, '');
  context.registerMerge(mergeTest, merge, 'gta5dlc');

  context.registerInstaller('gta5-mod', 25, replacerTest, replacerInstaller);

  context.once(() => {
    context.api.onAsync('did-deploy',
                        (profileId: string, deployment: any, progress: (title: string) => void) => {
      const state = context.api.store.getState();

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
      return Promise.resolve(OIV.fromFile(assemblyPath))
        .then(oiv => {
          // oiv.addDLC('vortex', path.join('update', 'update.rpf'), false);
          return oiv.save(assemblyPath);
        })
        .then(() => sZip.add(path.join(discovery.path, 'vortex.oiv.zip'), [
            assemblyPath,
            path.join(__dirname, 'content'),
            path.join(__dirname, 'icon.png'),
          ]))
        .then(() => sZip.update(path.join(discovery.path, 'vortex.oiv.zip'), [
          path.join(basePath, 'content'),
        ]))
        .then(() => fs.renameAsync(path.join(discovery.path, 'vortex.oiv.zip'),
                                   path.join(discovery.path, 'vortex.oiv')))
        .then(() => context.api.showDialog('info', 'Need to run OpenIV', {
          bbcode: 'To complete deployment you need to run OpenIV and run the "vortex.oiv" installer.'
                + `[img width="100%"]${path.join(__dirname, 'openiv_oiv.jpg')}[/img]`,
        }, [
          { label: 'Cancel' },
          { label: 'Continue' },
        ]))
        .then((result: types.IDialogResult) => result.action === 'Continue'
          ? fs.removeAsync(path.join(discovery.path, 'mods', RPF_PATH))
            .catch({ code: 'ENOENT' }, () => null)
            .then(() => runOpenIV(context.api))
          : Promise.reject(new util.UserCanceled()))
        .catch(util.UserCanceled, err => Promise.resolve(undefined));

      /* disabled. The openiv.asi file is encrypted or compressed with an unknown format so for now
       we need to deploy it through the OpenIV ASI Manager

      // ensure the current version of OpenIV.asi is installed
      return fs.copyAsync(path.join(openIVPath(), 'Games', 'Five', 'x64', 'OpenIV.asi'),
                          path.join(discovery.path, 'OpenIV.asi'))
        // we already have a notification about OpenIV being required
        .catch({ code: 'ENOENT' }, () => null)
        .catch(err => {
          context.api.showErrorNotification('Failed to deploy openiv.asi', err);
        });
      */
    });
  });

  return true;
}

export default main;
