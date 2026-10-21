import { randomUUID as RandomUUID } from 'node:crypto'
import { lstat as Lstat, open as Open, readFile as ReadFile, unlink as Unlink } from 'node:fs/promises'
import { basename as Basename, dirname as Dirname, join as Join } from 'node:path'
import { ConfigFormat, ParseConfig } from '../Server/Storage'

export const ConfigRecoveryPattern = /^\.HybridRefConfigRecovery_[A-Fa-f0-9-]+\.json$/
export class ConfigRecoveryError extends Error {
  constructor(Recovery: string, Cause: unknown) {
    super(`配置写入未能安全恢复，已保留原内容与目标内容，请先恢复后重试：${Recovery}`, { cause: Cause })
  }
}

/** A Windows reader can allow writes but deny the delete sharing rename needs.
 * Only mutable, validated resource configs may use this guarded fallback. */
export async function RewriteLockedConfig(Path: string, Before: Buffer, After: Buffer): Promise<void> {
  if (!/^(Texture|Text|Line)_[A-F0-9]{16}_[A-F0-9]{8}\.config$/.test(Basename(Path))) throw new Error('仅资源配置允许占用写入处理。')
  const Format = ConfigFormat(Path)
  ParseConfig(Before.toString('utf8'), Format)
  ParseConfig(After.toString('utf8'), Format)
  const Recovery = Join(Dirname(Path), `.HybridRefConfigRecovery_${RandomUUID()}.json`)
  const File = await Open(Path, 'r+').catch(CaughtError => {
    throw new Error(`资源配置被占用或不可写，请关闭占用该文件的程序后重试：${Path}`, { cause: CaughtError })
  })
  let BackedUp = false, Modified = false, RetainRecovery = false
  let Owned = Buffer.from(Before)
  try {
    const Status = await File.stat(), Current = await Lstat(Path)
    if (!Current.isFile() || Current.isSymbolicLink() || Status.ino !== Current.ino || Status.dev !== Current.dev || Status.nlink !== 1) {
      throw new Error(`配置路径已变化或存在硬链接，未覆盖：${Path}`)
    }
    if (!(await File.readFile()).equals(Before)) throw new Error(`文件在保存过程中被修改，未覆盖：${Path}`)
    const Backup = await Open(Recovery, 'wx')
    BackedUp = true
    try {
      await Backup.writeFile(JSON.stringify({ format: 'hybridref-config-recovery', formatVersion: 1, file: Basename(Path), before: Before.toString('utf8'), after: After.toString('utf8') }))
      await Backup.sync()
    } finally { await Backup.close() }
    // Recheck after the durable backup, before touching the existing inode.
    if (!(await ReadFile(Path)).equals(Before)) throw new Error(`文件在保存过程中被修改，未覆盖：${Path}`)
    for (let Offset = 0; Offset < After.length;) {
      Modified = true
      const { bytesWritten: Written } = await File.write(After, Offset, After.length - Offset, Offset)
      if (!Written) throw new Error('配置写入未取得进展。')
      if (Offset + Written > Owned.length) Owned = Buffer.concat([Owned, Buffer.alloc(Offset + Written - Owned.length)])
      After.copy(Owned, Offset, Offset, Offset + Written)
      Offset += Written
    }
    await File.truncate(After.length)
    Owned = Buffer.from(After)
    await File.sync()
    const Final = await Lstat(Path)
    if (Final.ino !== Status.ino || Final.dev !== Status.dev || !(await ReadFile(Path)).equals(After)) throw new Error(`配置在写入期间被其他程序修改：${Path}`)
  } catch (CaughtError) {
    if (Modified) {
      try {
        const Current = await ReadFile(Path)
        if (!Current.equals(Owned) && !Current.equals(After) && !Current.equals(Before)) throw new Error('文件已被其他程序修改，保留其内容。')
        const Status = await File.stat(), CurrentStatus = await Lstat(Path)
        if (Status.ino !== CurrentStatus.ino || Status.dev !== CurrentStatus.dev) throw new Error('配置路径已经替换。')
        for (let Offset = 0; Offset < Before.length;) {
          const { bytesWritten: Written } = await File.write(Before, Offset, Before.length - Offset, Offset)
          if (!Written) throw new Error('配置恢复未取得进展。')
          Offset += Written
        }
        await File.truncate(Before.length)
        await File.sync()
        if (!(await ReadFile(Path)).equals(Before)) throw new Error('配置恢复后内容不匹配。')
      } catch (RecoveryError) {
        RetainRecovery = true
        throw new ConfigRecoveryError(Recovery, RecoveryError)
      }
    }
    throw CaughtError
  } finally {
    await File.close()
    if (BackedUp && !RetainRecovery) await Unlink(Recovery).catch(CaughtError => { throw new ConfigRecoveryError(Recovery, CaughtError) })
  }
}
