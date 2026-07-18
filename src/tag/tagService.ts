import { workspace } from 'vscode'
import { runGit, resolveDefaultRemote, resolveRepoRoot } from './gitHost'
import type { CreateTagOptions, TagInfo, TagSyncStatus } from './types'

/** *object = 剥壳后的 commit；无则退回 object（lightweight） */
const LOCAL_FORMAT = [
  '%(refname:short)',
  '%(objectname:short)',
  '%(objectname)',
  '%(*objectname:short)',
  '%(*objectname)',
  '%(contents:subject)',
  '%(taggername)',
  '%(taggerdate:iso-strict)'
].join('%00')

type LocalTagRow = {
  name: string
  commit: string
  object: string
  annotation: string
  tagger: string
  when: string
}

const parseLocalTags = (stdout: string): LocalTagRow[] => {
  if (!stdout) {
    return []
  }
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, objShort, objFull, peeledShort, peeledFull, annotation, tagger, when] =
        line.split('\0')
      const commit = (peeledShort || objShort || '').trim()
      const object = (peeledFull || objFull || '').trim()
      return {
        name: name ?? '',
        commit,
        object,
        annotation: annotation ?? '',
        tagger: tagger ?? '',
        when: when ?? ''
      }
    })
    .filter(t => t.name)
}

/** ls-remote 输出：<sha>\\trefs/tags/name 或 ^{} 剥壳 */
const parseRemoteTags = (stdout: string): Map<string, string> => {
  const map = new Map<string, string>()
  if (!stdout) {
    return map
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const [sha, ref] = trimmed.split(/\s+/)
    if (!sha || !ref?.startsWith('refs/tags/')) {
      continue
    }
    let name = ref.slice('refs/tags/'.length)
    const peeled = name.endsWith('^{}')
    if (peeled) {
      name = name.slice(0, -3)
    }
    // 优先保留剥壳后的 commit（^{}）
    if (peeled || !map.has(name)) {
      map.set(name, sha.slice(0, 7))
    }
  }
  return map
}

const mergeSync = (
  local: LocalTagRow | undefined,
  remoteCommit: string | undefined
): { sync: TagSyncStatus; remoteCommit?: string } => {
  if (local && remoteCommit) {
    const localShort = local.commit
    if (localShort === remoteCommit || local.object.startsWith(remoteCommit) || remoteCommit.startsWith(localShort)) {
      return { sync: 'both' }
    }
    return { sync: 'diverged', remoteCommit }
  }
  if (local) {
    return { sync: 'local' }
  }
  return { sync: 'remote', remoteCommit }
}

export class TagService {
  async listTags(): Promise<{ repoRoot: string; tags: TagInfo[]; remote?: string } | undefined> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return undefined
    }
    const localRes = await runGit(repoRoot, [
      'for-each-ref',
      '--format',
      LOCAL_FORMAT,
      'refs/tags'
    ])
    const localRows = localRes.ok ? parseLocalTags(localRes.stdout) : []
    const localMap = new Map(localRows.map(r => [r.name, r]))

    const remote = await resolveDefaultRemote(repoRoot)
    let remoteMap = new Map<string, string>()
    if (remote) {
      const remoteRes = await runGit(repoRoot, ['ls-remote', '--tags', remote])
      if (remoteRes.ok) {
        remoteMap = parseRemoteTags(remoteRes.stdout)
      }
    }

    const names = new Set([...localMap.keys(), ...remoteMap.keys()])
    const tags: TagInfo[] = [...names]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(name => {
        const local = localMap.get(name)
        const remoteCommit = remoteMap.get(name)
        const { sync, remoteCommit: divergedRemote } = mergeSync(local, remoteCommit)
        return {
          name,
          commit: local?.commit ?? remoteCommit ?? '',
          object: local?.object,
          annotation: local?.annotation || undefined,
          tagger: local?.tagger || undefined,
          when: local?.when || undefined,
          sync,
          remoteCommit: divergedRemote
        }
      })

    return { repoRoot, tags, remote }
  }

  async createTag(opts: CreateTagOptions): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const args = ['tag']
    if (opts.kind === 'annotated') {
      args.push('-a', opts.name, '-m', opts.message ?? opts.name)
    } else {
      args.push(opts.name)
    }
    if (opts.ref) {
      args.push(opts.ref)
    }
    const res = await runGit(repoRoot, args)
    if (!res.ok) {
      return { ok: false, message: res.stderr || '创建失败' }
    }
    return { ok: true, message: `已创建 tag ${opts.name}` }
  }

  async deleteLocal(name: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const res = await runGit(repoRoot, ['tag', '-d', name])
    if (!res.ok) {
      return { ok: false, message: res.stderr || '删除本地 tag 失败' }
    }
    return { ok: true, message: `已删除本地 tag ${name}` }
  }

  async deleteRemote(name: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const remote = await resolveDefaultRemote(repoRoot)
    if (!remote) {
      return { ok: false, message: '未配置远程仓库（可在设置 simple-logs.tags.defaultRemote）' }
    }
    const res = await runGit(repoRoot, ['push', remote, `:refs/tags/${name}`])
    if (!res.ok) {
      return { ok: false, message: res.stderr || '删除远端 tag 失败' }
    }
    return { ok: true, message: `已删除远端 ${remote} tag ${name}` }
  }

  async pushOne(name: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const remote = await resolveDefaultRemote(repoRoot)
    if (!remote) {
      return { ok: false, message: '未配置远程仓库' }
    }
    const res = await runGit(repoRoot, ['push', remote, `refs/tags/${name}`])
    if (!res.ok) {
      return { ok: false, message: res.stderr || '推送失败' }
    }
    return { ok: true, message: `已推送 ${name} → ${remote}` }
  }

  async pushAll(): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const remote = await resolveDefaultRemote(repoRoot)
    if (!remote) {
      return { ok: false, message: '未配置远程仓库' }
    }
    const res = await runGit(repoRoot, ['push', remote, '--tags'])
    if (!res.ok) {
      return { ok: false, message: res.stderr || '推送失败' }
    }
    return { ok: true, message: `已推送全部 tags → ${remote}` }
  }

  /** 改名：新名指向旧 tag 同一对象，再删旧名（仅本地） */
  async rename(oldName: string, newName: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const create = await runGit(repoRoot, ['tag', newName, oldName])
    if (!create.ok) {
      return { ok: false, message: create.stderr || `无法创建 ${newName}` }
    }
    const del = await runGit(repoRoot, ['tag', '-d', oldName])
    if (!del.ok) {
      await runGit(repoRoot, ['tag', '-d', newName])
      return { ok: false, message: del.stderr || `已创建 ${newName} 但删除 ${oldName} 失败，已回滚` }
    }
    return { ok: true, message: `已改名 ${oldName} → ${newName}` }
  }

  /** 强制移动到指定 commit（-f）；annotated 时保留/重写消息 */
  async moveToCommit(
    name: string,
    ref: string,
    opts?: { force?: boolean; annotated?: boolean; message?: string }
  ): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const force = opts?.force !== false
    const args = ['tag']
    if (force) {
      args.push('-f')
    }
    if (opts?.annotated) {
      args.push('-a', name, '-m', opts.message ?? name, ref)
    } else {
      args.push(name, ref)
    }
    const res = await runGit(repoRoot, args)
    if (!res.ok) {
      return { ok: false, message: res.stderr || '移动 tag 失败' }
    }
    return { ok: true, message: `已将 ${name} 指向 ${ref}` }
  }

  /** fetch --tags */
  async fetchTags(): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const remote = await resolveDefaultRemote(repoRoot)
    if (!remote) {
      return { ok: false, message: '未配置远程仓库' }
    }
    const res = await runGit(repoRoot, ['fetch', remote, '--tags'])
    if (!res.ok) {
      return { ok: false, message: res.stderr || 'fetch tags 失败' }
    }
    return { ok: true, message: `已从 ${remote} 拉取 tags` }
  }

  /** fetch --prune --prune-tags：清理远端已删的本地 tag */
  async pruneTags(): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const remote = await resolveDefaultRemote(repoRoot)
    if (!remote) {
      return { ok: false, message: '未配置远程仓库' }
    }
    const res = await runGit(repoRoot, ['fetch', remote, '--prune', '--prune-tags'])
    if (!res.ok) {
      return { ok: false, message: res.stderr || 'prune tags 失败' }
    }
    return { ok: true, message: `已 prune ${remote} 上已删除的 tags` }
  }

  /** 从 tag 创建并检出新分支 */
  async createBranchFrom(tagName: string, branchName: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const res = await runGit(repoRoot, ['switch', '-c', branchName, tagName])
    if (!res.ok) {
      const fallback = await runGit(repoRoot, ['checkout', '-b', branchName, tagName])
      if (!fallback.ok) {
        return { ok: false, message: fallback.stderr || res.stderr || '创建分支失败' }
      }
    }
    return { ok: true, message: `已从 ${tagName} 创建并切换到分支 ${branchName}` }
  }

  /** detached HEAD 检出 tag */
  async checkoutDetach(tagName: string): Promise<{ ok: boolean; message: string }> {
    const repoRoot = await resolveRepoRoot()
    if (!repoRoot) {
      return { ok: false, message: '未找到 Git 仓库' }
    }
    const res = await runGit(repoRoot, ['switch', '--detach', tagName])
    if (!res.ok) {
      const fallback = await runGit(repoRoot, ['checkout', '--detach', tagName])
      if (!fallback.ok) {
        return { ok: false, message: fallback.stderr || res.stderr || '检出失败' }
      }
    }
    return { ok: true, message: `已 detached 检出 ${tagName}` }
  }

  confirmDangerousEnabled(): boolean {
    return workspace.getConfiguration('simple-logs').get<boolean>('tags.confirmDangerous') !== false
  }
}
