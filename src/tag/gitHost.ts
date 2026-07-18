import { extensions, workspace, window, Uri } from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getGitCommand } from '../gitcommand'

const execFileAsync = promisify(execFile)

/** vscode.git API（最小子集） */
type GitAPI = {
  repositories: { rootUri: { fsPath: string }; state: { remotes: { name: string }[] } }[]
  getRepository(uri: Uri): { rootUri: { fsPath: string } } | null
}

export type GitRunResult = {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/** 在指定目录执行 git（cwd 即仓库根或子目录，不再 dirname） */
export const runGit = async (cwd: string, args: string[]): Promise<GitRunResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(getGitCommand(), args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    })
    return {
      ok: true,
      stdout: (stdout ?? '').trim(),
      stderr: (stderr ?? '').trim(),
      code: 0
    }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
      code: typeof e.code === 'number' ? e.code : 1
    }
  }
}

const getGitAPI = async (): Promise<GitAPI | undefined> => {
  const ext = extensions.getExtension<{ enabled: boolean; getAPI(v: number): GitAPI }>('vscode.git')
  if (!ext) {
    return undefined
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate()
    if (!exports?.enabled) {
      return undefined
    }
    return exports.getAPI(1)
  } catch {
    return undefined
  }
}

/** 解析当前操作仓库根目录 */
export const resolveRepoRoot = async (): Promise<string | undefined> => {
  const api = await getGitAPI()
  const editor = window.activeTextEditor
  if (api && editor?.document.uri.scheme === 'file') {
    const repo = api.getRepository(editor.document.uri)
    if (repo) {
      return repo.rootUri.fsPath
    }
  }
  if (api?.repositories.length === 1) {
    return api.repositories[0].rootUri.fsPath
  }
  if (api && api.repositories.length > 1) {
    const picks = api.repositories.map(r => ({
      label: r.rootUri.fsPath,
      root: r.rootUri.fsPath
    }))
    const chosen = await window.showQuickPick(picks, { placeHolder: '选择 Git 仓库' })
    return chosen?.root
  }
  const folder = workspace.workspaceFolders?.[0]
  if (!folder) {
    return undefined
  }
  const rev = await runGit(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])
  return rev.ok ? rev.stdout : undefined
}

/** 默认远程：配置 > 唯一远程 > origin（若存在）> 第一个远程 */
export const resolveDefaultRemote = async (repoRoot: string): Promise<string | undefined> => {
  const configured = workspace.getConfiguration('simple-logs').get<string>('tags.defaultRemote')?.trim()
  const remotesResult = await runGit(repoRoot, ['remote'])
  if (!remotesResult.ok) {
    return configured || undefined
  }
  const remotes = remotesResult.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  if (configured && remotes.includes(configured)) {
    return configured
  }
  if (configured && remotes.length === 0) {
    return configured
  }
  if (remotes.length === 1) {
    return remotes[0]
  }
  if (remotes.includes('origin')) {
    return 'origin'
  }
  return remotes[0]
}
