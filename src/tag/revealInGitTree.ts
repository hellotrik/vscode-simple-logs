import * as vscode from 'vscode'
import { resolveRepoRoot, runGit } from './gitHost'

export type RevealInGitTreeResult = {
  ok: boolean
  message: string
  hash?: string
  /** 扩展命令是否已成功定位到图节点 */
  locatedInGraph: boolean
}

/**
 * 安全跳转：禁止伪 git.viewCommit / 乱调 git-graph.view / Detached 检出，
 * 那些会把内置 Source Control Graph 弄空或打乱。
 * 仅：复制 hash → 尝试配置的 GitLens 类命令 → 打开 SCM 面板。
 */
export const revealTagInGitTree = async (tagName: string): Promise<RevealInGitTreeResult> => {
  const resolved = await resolveTagCommitHash(tagName)
  if (!resolved) {
    return { ok: false, message: `无法解析 tag ${tagName} 的 commit`, locatedInGraph: false }
  }
  const { repoRoot, hash } = resolved
  const short = hash.slice(0, 7)

  await vscode.env.clipboard.writeText(hash)

  const locatedInGraph = await trySafeRevealCommands(repoRoot, hash, tagName)

  try {
    await vscode.commands.executeCommand('workbench.view.scm')
  } catch {
    // ignore
  }

  if (locatedInGraph) {
    return {
      ok: true,
      hash,
      locatedInGraph: true,
      message: `已在 Git 图定位「${tagName}」（${short}）`
    }
  }
  return {
    ok: true,
    hash,
    locatedInGraph: false,
    message: `已复制 commit ${short}，并打开源代码管理。内置图表无公开「滚到任意节点」API；装 GitLens 后可自动定位（设置 revealInGraphCommands）。`
  }
}

/** 解析 tag 指向的完整 commit hash */
export const resolveTagCommitHash = async (
  tagName: string
): Promise<{ repoRoot: string; hash: string } | undefined> => {
  const repoRoot = await resolveRepoRoot()
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

const trySafeRevealCommands = async (
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
  // 只尝试已存在的命令；参数形态保守，失败即换下一形态/下一命令
  const argSets: unknown[][] = [
    [{ ref: hash, repoPath: repoRoot, sha: hash }],
    [{ ref: { repoPath: repoRoot, ref: hash, name: tagName } }],
    [hash]
  ]
  for (const cmd of configured) {
    // 明确跳过曾破坏内置图的命令名
    if (/^git-graph\./i.test(cmd) || cmd === 'git.viewCommit') {
      continue
    }
    if (!available.has(cmd)) {
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
