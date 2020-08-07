import * as fs from 'fs-extra';
import * as path from 'path';
import { Builder, parseStringPromise } from 'xml2js';

function setdefault<T>(obj: any, key: PropertyKey, def: T): T {
  if (!obj.hasOwnProperty(key)) {
    obj[key] = def;
  }
  return obj[key];
}

interface IOIVFormatPackage {
  version: string;
  id: string;
  target: string;
}

interface IOIVFormatMetaVersion {
  major: string[];
  minor: string[];
  tag?: string[];
}

interface IOIVFormatAuthor {
  displayName: string[];
  actionLink?: string[];
  web?: string[];
  facebook?: string[];
  twitter?: string[];
  youtube?: string[];
}

type XMLString<M> = string | {
  _: string,
  $: M,
};

function xmlStringEq(lhs: XMLString<any>, rhs: string): boolean {
  const lhsX = typeof (lhs) === 'string' ? lhs : lhs._;
  return lhsX === rhs;
}

interface IFooterLink {
  footerLink?: string;
  footerLinkTitle?: string;
}

// .metadata[0].author[0].displayName[0]
interface IOIVFormatMetadata {
  name: string[];
  version: IOIVFormatMetaVersion[];
  author: IOIVFormatAuthor[];
  description: XMLString<IFooterLink>[];
  largeDescription: XMLString<IFooterLink | { displayName?: string }>[];
  license: XMLString<IFooterLink>[];
}

interface IOIVFormatColors {
  headerBackground: XMLString<{ useBlackTextColor: boolean }>[];
  iconBackground: string[];
}

interface IOIVFormatArchiveHeader {
  path: string;
  createIfNotExist: string;
  type: string;
}

interface IOIVFormatTextInsert {
  $: { where: string, line: string, condition: string };
  _: string;
}

interface IOIVFormatTextReplace {
  $: { line: string, condition: string };
  _: string;
}

interface IOIVFormatTextDelete {
  $: { condition: string };
  _: string;
}

interface IOIVFormatText {
  $: { path: string, createIfNotExist: string };
  insert: IOIVFormatTextInsert[];
  replace: IOIVFormatTextReplace[];
  delete: IOIVFormatTextDelete[];
}

interface IOIVFormatXMLItem {
  $: { xpath: string, append?: string };
  item: string[];
}

interface IOIVFormatXML {
  $: { path: string };
  add: IOIVFormatXMLItem[];
  replace: IOIVFormatXMLItem[];
  remove: Array<{ $: { xpath: string } }>;
}

interface IOIVFormatArchive {
  $: IOIVFormatArchiveHeader;
  add?: XMLString<{ source: string }>[];
  delete?: string[];
  defragmentation?: Array<{ $: { archive: string } }>;
  text?: IOIVFormatText[];
  xml?: IOIVFormatXML[];
  archive?: IOIVFormatArchive[];
}

interface IOIVFormatContent {
  add?: XMLString<{ source: string }>[];
  delete?: string[];
  archive?: IOIVFormatArchive[]
}

interface IOIVFormat {
  package: {
    $: IOIVFormatPackage,
    metadata: IOIVFormatMetadata[],
    colors: IOIVFormatColors[],
    content: IOIVFormatContent[],
  }
}

export function crowbar(obj: any, path: (string | number)[], def: any): any {
  let parent = obj;
  let cur = parent[path[0]];
  let length = path.length;

  const forceType = (idx: number) => {
    if ((typeof (path[idx]) === 'number')
        && (!Array.isArray(cur))) {
      cur = parent[path[idx - 1]] = [];
    } else if ((typeof (path[idx]) === 'string')
               && (typeof (cur) !== 'object')) {
      cur = parent[path[idx - 1]] = {};
    }
  }

  for (let i = 1; i < length; ++i) {
    forceType(i);
    parent = cur;
    cur = parent[path[i]];
  }

  if (cur === undefined) {
    cur = parent[path[length - 1]] = def;
  }

  return cur;
}

export interface IOIVOptions {
  rpfVersion: 'RPF7';
}

class OIV {
  private mData: IOIVFormat;
  private mOptions: IOIVOptions;
  constructor(parsed: IOIVFormat, options: IOIVOptions) {
    if (!parsed) {
      throw new Error('invalid assembly data');
    }
    this.mData = parsed;
    this.mOptions = options;
  }

  public static fromFile(filePath: string, options: IOIVOptions): Promise<OIV> {
    return Promise.resolve(fs.readFile(filePath, { encoding: 'utf8' }))
      .then(data => OIV.fromData(data, options));
  }

  public static fromData(input: string, options: IOIVOptions): Promise<OIV> {
    return parseStringPromise(input, { trim: true })
      .then(parsed => {
        return Promise.resolve(new OIV(parsed, options));
      });
  }

  public toString(): string {
    const builder = new Builder({
      cdata: true,
      xmldec: { 'version': '1.0', 'encoding': 'UTF-8' },
    });
    return builder.buildObject(this.mData);
  }

  public save(filePath: string): Promise<void> {
    return fs.writeFile(filePath, this.toString(), { encoding: 'utf-8' });
  }

  /**
   * merge all content changes from one oiv into this
   * @param oivPath path to the other oiv
   * @param sourcePrefix gets pretended to all "add" source paths. Useful when the content directory gets
   *                     rearranged
   */
  public merge(oivPath: string, sourcePrefix: string): Promise<void> {
    return OIV.fromFile(path.join(oivPath, 'assembly.xml'), this.mOptions)
      .then(oiv => {
        if (this.mData.package.content[0] === '') {
          this.mData.package.content[0] = {};
        }
        const lhs = this.mData.package.content[0];
        const rhs = oiv.mData.package?.content?.[0] || {};
        if (rhs.add !== undefined) {
          lhs.add = (lhs.add || []).concat(...rhs.add.map(iter => this.updateSource(iter, sourcePrefix)));
        }
        if (rhs.delete !== undefined) {
          lhs.delete = (lhs.delete || []).concat(...rhs.delete);
        }

        const updateArchive = (arch: IOIVFormatArchive): IOIVFormatArchive => {
          const result: IOIVFormatArchive = { ...arch };
          if (arch.add !== undefined) {
            result.add = arch.add.map(iter => this.updateSource(iter, sourcePrefix));
          }
          if (arch.archive !== undefined) {
            result.archive = arch.archive.map(updateArchive);
          }
          return result;
        };

        if (rhs.archive !== undefined) {
          lhs.archive = (lhs.archive || []).concat(...rhs.archive.map(updateArchive));
        }
        return Promise.resolve();
      });
  }

  /**
   * set a dlc to be loaded
   * @param name name of the dlc
   */
  public addDLC(name: string) {
    const archive: IOIVFormatArchive = this.ensureArchive(path.join('update', 'update.rpf'));

    const dlcListPath = path.join('common', 'data', 'dlclist.xml');

    const xmlEdits = setdefault<IOIVFormatXML[]>(archive, 'xml', []);
    let dlclist = xmlEdits.find(iter => iter.$.path === dlcListPath);
    if (dlclist === undefined) {
      dlclist = xmlEdits[xmlEdits.push({
        $: { path: dlcListPath },
        add: [],
        remove: [],
        replace: [],
      }) - 1];
    }

    dlclist.add.push({
      $: { xpath: '/SMandatoryPacksData/Paths' },
      item: [ {
        $: { id: name },
        _: `dlcpacks:/${name}/`,
       } as any ],
    });
  }

  /**
   * add a file to the archive
   * @param inPath path to the file within the content directory of the oiv
   * @param outPath path to the file in the target archive
   * @param archiveName name of the archive to add to
   */
  public addFile(inPath: string, outPath: string, archiveName: string) {
    let archive = this.ensureArchive(archiveName);
    const segments: string[] = outPath.split(path.sep).reduce((prev, iter) => {
      prev[prev.length - 1].push(iter);
      if (path.extname(iter) === '.rpf') {
        prev.push([]);
      }
      return prev;
    }, [[]])
    .map(iter => iter.join(path.sep));

    for (let i = 0; i < segments.length - 1; ++i) {
      const subArchives = crowbar(archive, ['archive'], []);
      archive = subArchives.find(iter => iter.$.path === segments[i]);
      if (archive === undefined) {
        archive = subArchives[subArchives.push({
          $: { path: segments[i], createIfNotExist: 'True', type: this.mOptions.rpfVersion },
        }) - 1];
      }
    }

    crowbar(archive, ['add'], []).push({
      $: { source: inPath },
      _: segments[segments.length - 1],
    });
  }

  private updateSource(iter: XMLString<{ source: string }>, prefix: string): XMLString<{ source: string }> {
    if (typeof(iter) !== 'string') {
      return { _: iter._, $: { source: path.join(prefix, iter.$.source) } };
    } else {
      return iter;
    }
  }

  private mergeData(target: any, source: any) {
    if (Array.isArray(source)) {
      target.push(...source);
    } else {
      Object.keys(source).forEach(key => {
        if (target[key] === undefined) {
          target[key] = source[key];
        } else {
          this.mergeData(target[key], source[key]);
        }
      });
    }
  }

  private ensureArchive(path: string): IOIVFormatArchive {
    const archives = crowbar(this.mData, ['package', 'content', 0, 'archive'], []);
    let arch = archives.find(iter => iter.$.path === path);
    if (arch === undefined) {
      arch = archives[archives.push({
        $: { path, createIfNotExist: 'True', type: this.mOptions.rpfVersion },
      }) - 1];
    }
    return arch;
  }
}

export default OIV;
