import fs from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import tar from 'tar';
import {
  AccessLevel,
  SingletonProto,
  Inject,
} from '@eggjs/tegg';
import { AbstractService } from '../../common/AbstractService';
import {
  calculateIntegrity,
} from '../../common/PackageUtil';
import { createTempDir, mimeLookup } from '../../common/FileUtil';
import {
  PackageRepository,
} from '../../repository/PackageRepository';
import { PackageVersionFileRepository } from '../../repository/PackageVersionFileRepository';
import { DistRepository } from '../../repository/DistRepository';
import { PackageVersionFile } from '../entity/PackageVersionFile';
import { PackageVersion } from '../entity/PackageVersion';
import { Package } from '../entity/Package';
import { PackageManagerService } from './PackageManagerService';

@SingletonProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class PackageVersionFileService extends AbstractService {
  @Inject()
  private readonly packageRepository: PackageRepository;
  @Inject()
  private readonly packageVersionFileRepository: PackageVersionFileRepository;
  @Inject()
  private readonly distRepository: DistRepository;
  @Inject()
  private readonly packageManagerService: PackageManagerService;

  async listPackageVersionFiles(pkgVersion: PackageVersion, directory: string) {
    await this.#ensurePackageVersionFilesSync(pkgVersion);
    return await this.packageVersionFileRepository.listPackageVersionFiles(pkgVersion.packageVersionId, directory);
  }

  async showPackageVersionFile(pkgVersion: PackageVersion, path: string) {
    await this.#ensurePackageVersionFilesSync(pkgVersion);
    const { directory, name } = this.#getDirectoryAndName(path);
    return await this.packageVersionFileRepository.findPackageVersionFile(
      pkgVersion.packageVersionId, directory, name);
  }

  async #ensurePackageVersionFilesSync(pkgVersion: PackageVersion) {
    const hasFiles = await this.packageVersionFileRepository.hasPackageVersionFiles(pkgVersion.packageVersionId);
    if (!hasFiles) {
      await this.syncPackageVersionFiles(pkgVersion);
    }
  }

  async syncPackageVersionFiles(pkgVersion: PackageVersion) {
    const files: PackageVersionFile[] = [];
    const pkg = await this.packageRepository.findPackageByPackageId(pkgVersion.packageId);
    if (!pkg) return files;
    const dirname = `unpkg_${pkg.fullname.replace('/', '_')}@${pkgVersion.version}_${randomUUID()}`;
    const tmpdir = await createTempDir(this.config.dataDir, dirname);
    const tarFile = `${tmpdir}.tgz`;
    const paths: string[] = [];
    let readmeFilename = '';
    try {
      this.logger.info('[PackageVersionFileService.syncPackageVersionFiles:download-start] dist:%s(path:%s, size:%s) => tarFile:%s',
        pkgVersion.tarDist.distId, pkgVersion.tarDist.path, pkgVersion.tarDist.size, tarFile);
      await this.distRepository.downloadDistToFile(pkgVersion.tarDist, tarFile);
      this.logger.info('[PackageVersionFileService.syncPackageVersionFiles:extract-start] tmpdir:%s', tmpdir);
      await tar.extract({
        file: tarFile,
        cwd: tmpdir,
        strip: 1,
        onentry: entry => {
          if (entry.type !== 'File') return;
          // ignore hidden dir
          if (entry.path.includes('/./')) return;
          // https://github.com/cnpm/cnpmcore/issues/452#issuecomment-1570077310
          // strip first dir, e.g.: 'package/', 'lodash-es/'
          const filename = entry.path.split('/').slice(1).join('/');
          paths.push('/' + filename);
          if (!readmeFilename) {
            if (filename === 'README.md' || filename === 'readme.md' || filename === 'Readme.md') {
              readmeFilename = filename;
            }
          }
        },
      });
      for (const path of paths) {
        const localFile = join(tmpdir, path);
        const file = await this.#savePackageVersionFile(pkg, pkgVersion, path, localFile);
        files.push(file);
      }
      this.logger.info('[PackageVersionFileService.syncPackageVersionFiles:success] packageVersionId: %s, %d paths, %d files, tmpdir: %s',
        pkgVersion.packageVersionId, paths.length, files.length, tmpdir);
      if (readmeFilename) {
        const readmeFile = join(tmpdir, readmeFilename);
        await this.packageManagerService.savePackageVersionReadme(pkgVersion, readmeFile);
      }
      return files;
    } catch (err) {
      this.logger.warn('[PackageVersionFileService.syncPackageVersionFiles:error] packageVersionId: %s, %d paths, tmpdir: %s, error: %s',
        pkgVersion.packageVersionId, paths.length, tmpdir, err);
      // ignore TAR_BAD_ARCHIVE error
      if (err.code === 'TAR_BAD_ARCHIVE') return files;
      throw err;
    } finally {
      try {
        await fs.rm(tarFile, { force: true });
        await fs.rm(tmpdir, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn('[PackageVersionFileService.syncPackageVersionFiles:warn] remove tmpdir: %s, error: %s',
          tmpdir, err);
      }
    }
  }

  async #savePackageVersionFile(pkg: Package, pkgVersion: PackageVersion, path: string, localFile: string) {
    const { directory, name } = this.#getDirectoryAndName(path);
    let file = await this.packageVersionFileRepository.findPackageVersionFile(
      pkgVersion.packageVersionId, directory, name);
    if (file) return file;
    const stat = await fs.stat(localFile);
    const distIntegrity = await calculateIntegrity(localFile);
    // make sure dist.path store to ascii, e.g. '/resource/ToOneFromχ.js' => '/resource/ToOneFrom%CF%87.js'
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURI
    const distPath = encodeURI(path);
    const dist = pkg.createPackageVersionFile(distPath, pkgVersion.version, {
      size: stat.size,
      shasum: distIntegrity.shasum,
      integrity: distIntegrity.integrity,
    });
    await this.distRepository.saveDist(dist, localFile);
    file = PackageVersionFile.create({
      packageVersionId: pkgVersion.packageVersionId,
      directory,
      name,
      dist,
      contentType: mimeLookup(path),
      mtime: pkgVersion.publishTime,
    });
    try {
      await this.packageVersionFileRepository.createPackageVersionFile(file);
      this.logger.info('[PackageVersionFileService.#savePackageVersionFile:success] fileId: %s, size: %s, path: %s',
        file.packageVersionFileId, dist.size, file.path);
    } catch (err) {
      // ignore Duplicate entry
      if (err.code === 'ER_DUP_ENTRY') return file;
      throw err;
    }
    return file;
  }

  #getDirectoryAndName(path: string) {
    return {
      directory: dirname(path),
      name: basename(path),
    };
  }
}
