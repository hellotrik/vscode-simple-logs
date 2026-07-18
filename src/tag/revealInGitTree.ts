import { execFile } from 'child_process'
import * as path from 'path'
import { promisify } from 'util'
import * as vscode from 'vscode'
import { getGitCommand } from '../gitcommand'
import { resolveRepoRoot, runGit } from './gitHost'

const execFileAsync = promisify(execFile)

/** 空 tree object（stdin 空内容），避免硬编码 hash */
const emptyTreeHash = async (repoRoot: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(
      '/bin/bash',
      ['-lc', `"${getGitCommand()}" hash-object -t tree --stdin </dev/null`],
      { cwd: repoRoot, encoding: 'utf-8' }
    )
    const hash = String(stdout).trim()
    return hash || undefined
  } catch {
    return undefined
  }
}

export type RevealInGitTreeResult = {
  ok: boolean
  message: string
  hash?: string
}

export type RevealTagTarget = {
  tagName: string
  /** Tags 列表所在仓库；优先于重新 resolve */
  repoRoot?: string
  /** 已知 commit（完整或短 hash） */
  commit?: string
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 解析 tag 指向的完整 commit hash */
export const resolveTagCommitHash = async (
  tagName: string,
  preferredRoot?: string
): Promise<{ repoRoot: string; hash: string } | undefined> => {
  const repoRoot = preferredRoot || (await resolveRepoRoot())
  if (!repoRoot) {
    return undefined
  }
  const peeled = await runGit(repoRoot, ['rev-parse', `${tagName}^{}`])
  if (peeled.ok && peeled.stdout) {
    return { repoRoot, hash: peeled.stdout }
  }
  const plain = await runGit(repoRoot, ['rev-parse', tagName])
  if (plain.ok && plain.stdout) {
    return { repoRoot, hash: plain.stdout }
  }
  return undefined
}

const toGitUri = (fsPath: string, ref: string): vscode.Uri => {
  const file = vscode.Uri.file(fsPath)
  return file.with({
    scheme: 'git',
    path: file.path,
    query: JSON.stringify({ path: fsPath, ref })
  })
}

/** 与内置「查看提交变更」同构：打开 multi-diff，不碰 Graph 筛选/不 checkout */
const openCommitMultiDiff = async (repoRoot: string, hash: string): Promise<boolean> => {
  const subjectRes = await runGit(repoRoot, ['log', '-1', '--format=%s', hash])
  const subject = subjectRes.ok && subjectRes.stdout ? subjectRes.stdout : hash.slice(0, 7)

  const parentRes = await runGit(repoRoot, ['rev-parse', `${hash}^`])
  let parent: string
  if (parentRes.ok && parentRes.stdout) {
    parent = parentRes.stdout
  } else {
    // 根提交：父为 empty tree
    const empty = await emptyTreeHash(repoRoot)
    if (!empty) {
      return false
    }
    parent = empty
  }

  const diff = await runGit(repoRoot, [
    'diff-tree',
    '-r',
    '--no-commit-id',
    '--name-status',
    '-z',
    parent,
    hash
  ])
  if (!diff.ok) {
    return false
  }

  type DiffRes = { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri }
  const resources: DiffRes[] = []
  const parts = diff.stdout.split('\0').filter(Boolean)
  // -z name-status: STATUS\0path\0 或 Rxxx\0old\0new\0
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++] ?? ''
    const code = status.charAt(0)
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++] ?? ''
      const newPath = parts[i++] ?? ''
      resources.push({
        originalUri: toGitUri(path.join(repoRoot, oldPath), parent),
        modifiedUri: toGitUri(path.join(repoRoot, newPath), hash)
      })
    } else if (code === 'A') {
      const filePath = parts[i++] ?? ''
      resources.push({
        originalUri: undefined,
        modifiedUri: toGitUri(path.join(repoRoot, filePath), hash)
      })
    } else if (code === 'D') {
      const filePath = parts[i++] ?? ''
      resources.push({
        originalUri: toGitUri(path.join(repoRoot, filePath), parent),
        modifiedUri: undefined
      })
    } else {
      const filePath = parts[i++] ?? ''
      resources.push({
        originalUri: toGitUri(path.join(repoRoot, filePath), parent),
        modifiedUri: toGitUri(path.join(repoRoot, filePath), hash)
      })
    }
  }

  const short = hash.slice(0, 7)
  const multiDiffSourceUri = vscode.Uri.from({
    scheme: 'scm-history-item',
    path: `${repoRoot}/${parent}..${hash}`
  })
  await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
    multiDiffSourceUri,
    title: `${short} - ${subject}`,
    resources
  })
  return true
}

const focusSourceControlGraph = async (): Promise<void> => {
  // 正确入口是 workbench.scm.history（内置「源代码管理图」），不是 view.scm
  try {
    await vscode.commands.executeCommand('workbench.scm.history')
  } catch {
    try {
      await vscode.commands.executeCommand('workbench.view.scm')
    } catch {
      // ignore
    }
  }
}

const tryConfiguredGraphCommands = async (
  repoRoot: string,
  hash: string,
  tagName: string
): Promise<boolean> => {
  const configured =
    vscode.workspace.getConfiguration('simple-logs').get<string[]>('tags.revealInGraphCommands') ??
    []
  if (configured.length === 0) {
    return false
  }
  const available = new Set(await vscode.commands.getCommands(true))
  const argSets: unknown[][] = [
    [{ ref: hash, repoPath: repoRoot, sha: hash }],
    [{ ref: { repoPath: repoRoot, ref: hash, name: tagName } }],
    [hash]
  ]
  for (const cmd of configured) {
    if (!available.has(cmd) || /^git-graph\./i.test(cmd)) {
      continue
    }
    for (const args of argSets) {
      try {
        await vscode.commands.executeCommand(cmd, ...args)
        return true
      } catch {
        // next
      }
    }
  }
  return false
}

/**
 * 从 Tag 跳到对应 commit：
 * 1) 打开内置 Source Control Graph（workbench.scm.history）
 * 2) 打开该 commit 的 multi-diff（与图里「查看提交变更」同构）
 * 3) 若装了 GitLens 等，再尝试滚到图节点
 *
 * 禁止：伪 Repository shim、Detached 检出、乱调 git-graph.view。
 */
export const revealTagInGitTree = async (
  target: string | RevealTagTarget
): Promise<RevealInGitTreeResult> => {
  const tagName = typeof target === 'string' ? target : target.tagName
  const preferredRoot = typeof target === 'string' ? undefined : target.repoRoot
  const hintCommit = typeof target === 'string' ? undefined : target.commit

  let repoRoot = preferredRoot
  let hash: string | undefined

  if (hintCommit && preferredRoot) {
    const full = await runGit(preferredRoot, ['rev-parse', hintCommit])
    if (full.ok && full.stdout) {
      repoRoot = preferredRoot
      hash = full.stdout
    }
  }
  if (!hash) {
    const resolved = await resolveTagCommitHash(tagName, preferredRoot)
    if (!resolved) {
      return { ok: false, message: `无法解析 tag ${tagName} 的 commit` }
    }
    repoRoot = resolved.repoRoot
    hash = resolved.hash
  }
  if (!repoRoot || !hash) {
    return { ok: false, message: `无法解析 tag ${tagName} 的 commit` }
  }

  const short = hash.slice(0, 7)
  await vscode.env.clipboard.writeText(hash)

  await focusSourceControlGraph()
  // 给 Graph 一点时间挂上，再开 diff（避免只停在 Tags 列表）
  await sleep(150)

  let opened = await openCommitMultiDiff(repoRoot, hash)
  if (!opened) {
    try {
      await vscode.commands.executeCommand('git.viewCommit', vscode.Uri.file(repoRoot), hash)
      opened = true
    } catch {
      opened = false
    }
  }

  const locatedInGraph = await tryConfiguredGraphCommands(repoRoot, hash, tagName)

  if (!opened && !locatedInGraph) {
    return {
      ok: false,
      hash,
      message: `已复制 ${short} 并打开图表，但未能打开 commit 变更`
    }
  }

  return {
    ok: true,
    hash,
    message: locatedInGraph
      ? `已定位「${tagName}」→ ${short}`
      : `已打开图表，并打开「${tagName}」→ ${short} 的变更`
  }
}
