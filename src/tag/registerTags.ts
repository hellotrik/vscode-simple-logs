import * as vscode from 'vscode'
import { TagService } from './tagService'
import { TagTreeItem, TagTreeProvider } from './tagTreeProvider'
import type { CreateTagOptions } from './types'
import { revealTagInGitTree } from './revealInGitTree'

const asTagItem = (arg: unknown): TagTreeItem | undefined =>
  arg instanceof TagTreeItem ? arg : undefined

export const registerTagFeatures = (context: vscode.ExtensionContext): void => {
  const service = new TagService()
  const provider = new TagTreeProvider(service)
  const tree = vscode.window.createTreeView('simple-logs.tags', {
    treeDataProvider: provider,
    showCollapseAll: false
  })

  const refresh = () => provider.refresh()

  const notify = async (result: { ok: boolean; message: string }, doRefresh = true) => {
    if (result.ok) {
      vscode.window.showInformationMessage(result.message)
      if (doRefresh) {
        refresh()
      }
    } else {
      vscode.window.showErrorMessage(result.message)
    }
  }

  const confirmDanger = async (message: string): Promise<boolean> => {
    if (!service.confirmDangerousEnabled()) {
      return true
    }
    const pick = await vscode.window.showWarningMessage(message, { modal: true }, '继续')
    return pick === '继续'
  }

  context.subscriptions.push(
    tree,
    vscode.commands.registerCommand('simple-logs.tags.refresh', () => refresh()),
    vscode.commands.registerCommand('simple-logs.tags.create', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Tag 名称',
        placeHolder: 'v1.0.0',
        validateInput: v => (!v.trim() ? '名称不能为空' : undefined)
      })
      if (!name) {
        return
      }
      const kindPick = await vscode.window.showQuickPick(
        [
          {
            label: 'Annotated',
            description: '带注解消息（推荐发版）',
            tagKind: 'annotated' as const
          },
          {
            label: 'Lightweight',
            description: '轻量 tag',
            tagKind: 'lightweight' as const
          }
        ],
        { placeHolder: '选择 Tag 类型' }
      )
      if (!kindPick) {
        return
      }
      let message: string | undefined
      if (kindPick.tagKind === 'annotated') {
        message = await vscode.window.showInputBox({
          prompt: '注解消息',
          placeHolder: name,
          value: name
        })
        if (message === undefined) {
          return
        }
      }
      const ref = await vscode.window.showInputBox({
        prompt: '指向的 commit / ref（留空 = HEAD）',
        placeHolder: 'HEAD'
      })
      if (ref === undefined) {
        return
      }
      const opts: CreateTagOptions = {
        name: name.trim(),
        kind: kindPick.tagKind,
        message: message?.trim() || undefined,
        ref: ref.trim() || undefined
      }
      await notify(await service.createTag(opts))
    }),
    vscode.commands.registerCommand('simple-logs.tags.showDetails', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      const lines = [
        `Tag: ${tag.name}`,
        `Commit: ${tag.commit}`,
        `Sync: ${tag.sync}`,
        tag.remoteCommit ? `Remote commit: ${tag.remoteCommit}` : undefined,
        tag.annotation ? `Message: ${tag.annotation}` : undefined,
        tag.tagger ? `Tagger: ${tag.tagger}` : undefined,
        tag.when ? `When: ${tag.when}` : undefined,
        provider.getRemote() ? `Remote: ${provider.getRemote()}` : 'Remote: （未解析）'
      ].filter(Boolean)
      await vscode.window.showInformationMessage(lines.join('\n'))
    }),
    vscode.commands.registerCommand('simple-logs.tags.copyName', async (item?: TagTreeItem) => {
      const name = asTagItem(item)?.tag.name
      if (!name) {
        return
      }
      await vscode.env.clipboard.writeText(name)
      vscode.window.showInformationMessage(`已复制: ${name}`)
    }),
    vscode.commands.registerCommand('simple-logs.tags.deleteLocal', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'remote') {
        vscode.window.showWarningMessage('该 tag 仅在远端，无本地引用')
        return
      }
      if (!(await confirmDanger(`删除本地 tag「${tag.name}」？`))) {
        return
      }
      await notify(await service.deleteLocal(tag.name))
    }),
    vscode.commands.registerCommand('simple-logs.tags.deleteRemote', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'local') {
        vscode.window.showWarningMessage('该 tag 仅在本地，远端无此引用')
        return
      }
      if (!(await confirmDanger(`删除远端 tag「${tag.name}」？此操作影响远程仓库。`))) {
        return
      }
      await notify(await service.deleteRemote(tag.name))
    }),
    vscode.commands.registerCommand('simple-logs.tags.deleteBoth', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (!(await confirmDanger(`同时删除本地与远端 tag「${tag.name}」？`))) {
        return
      }
      if (tag.sync !== 'remote') {
        const local = await service.deleteLocal(tag.name)
        if (!local.ok) {
          await notify(local)
          return
        }
      }
      if (tag.sync !== 'local') {
        await notify(await service.deleteRemote(tag.name))
        return
      }
      await notify({ ok: true, message: `已删除本地 tag ${tag.name}` })
    }),
    vscode.commands.registerCommand('simple-logs.tags.pushOne', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'remote') {
        vscode.window.showWarningMessage('仅远端存在，无需推送')
        return
      }
      await notify(await service.pushOne(tag.name))
    }),
    vscode.commands.registerCommand('simple-logs.tags.pushAll', async () => {
      await notify(await service.pushAll())
    }),
    vscode.commands.registerCommand('simple-logs.tags.fetch', async () => {
      await notify(await service.fetchTags())
    }),
    vscode.commands.registerCommand('simple-logs.tags.prune', async () => {
      if (!(await confirmDanger('执行 fetch --prune --prune-tags？将清理远端已删除的本地 tags。'))) {
        return
      }
      await notify(await service.pruneTags())
    }),
    vscode.commands.registerCommand('simple-logs.tags.rename', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'remote') {
        vscode.window.showWarningMessage('仅远端存在，请先 fetch 或创建本地 tag')
        return
      }
      const newName = await vscode.window.showInputBox({
        prompt: `将「${tag.name}」改名为`,
        value: tag.name,
        validateInput: v => {
          const t = v.trim()
          if (!t) {
            return '名称不能为空'
          }
          if (t === tag.name) {
            return '新旧名称相同'
          }
          return undefined
        }
      })
      if (!newName) {
        return
      }
      await notify(await service.rename(tag.name, newName.trim()))
    }),
    vscode.commands.registerCommand('simple-logs.tags.move', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'remote') {
        vscode.window.showWarningMessage('仅远端存在，无法在本地移动')
        return
      }
      const ref = await vscode.window.showInputBox({
        prompt: `将「${tag.name}」移动到 commit / ref`,
        placeHolder: 'HEAD 或 commit hash',
        value: 'HEAD'
      })
      if (ref === undefined || !ref.trim()) {
        return
      }
      if (!(await confirmDanger(`强制将 tag「${tag.name}」指向「${ref.trim()}」？（git tag -f）`))) {
        return
      }
      const wantAnnotated = Boolean(tag.annotation || tag.tagger)
      await notify(
        await service.moveToCommit(tag.name, ref.trim(), {
          force: true,
          annotated: wantAnnotated,
          message: tag.annotation || tag.name
        })
      )
    }),
    vscode.commands.registerCommand('simple-logs.tags.editMessage', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (tag.sync === 'remote') {
        vscode.window.showWarningMessage('仅远端存在，请先 fetch 到本地再改消息')
        return
      }
      const isLightweight = !tag.annotation && !tag.tagger
      const message = await vscode.window.showInputBox({
        prompt: isLightweight
          ? `为「${tag.name}」设置注解消息（将升级为 annotated）`
          : `修改「${tag.name}」的注解消息`,
        value: tag.annotation || tag.name,
        placeHolder: 'tag message',
        validateInput: v => (!v.trim() ? '消息不能为空' : undefined)
      })
      if (message === undefined) {
        return
      }
      const tip =
        tag.sync === 'both' || tag.sync === 'diverged'
          ? `将用 git tag -f -a 重建「${tag.name}」；远端旧对象需再推送才会更新。继续？`
          : `将用 git tag -f -a 重建「${tag.name}」的注解。继续？`
      if (!(await confirmDanger(tip))) {
        return
      }
      await notify(await service.editMessage(tag.name, message.trim()))
    }),
    vscode.commands.registerCommand('simple-logs.tags.createBranch', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      const branch = await vscode.window.showInputBox({
        prompt: `从 tag「${tag.name}」创建分支`,
        value: tag.name.replace(/^v/, ''),
        validateInput: v => (!v.trim() ? '分支名不能为空' : undefined)
      })
      if (!branch) {
        return
      }
      await notify(await service.createBranchFrom(tag.name, branch.trim()), false)
      refresh()
    }),
    vscode.commands.registerCommand('simple-logs.tags.checkout', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      if (!(await confirmDanger(`Detached 检出 tag「${tag.name}」？将离开当前分支。`))) {
        return
      }
      await notify(await service.checkoutDetach(tag.name), false)
      refresh()
    }),
    vscode.commands.registerCommand('simple-logs.tags.revealInGitTree', async (item?: TagTreeItem) => {
      const tag = asTagItem(item)?.tag
      if (!tag) {
        return
      }
      const result = await revealTagInGitTree({
        tagName: tag.name,
        repoRoot: provider.getRepoRoot(),
        commit: tag.object ?? tag.commit
      })
      if (!result.ok) {
        vscode.window.showErrorMessage(result.message)
        return
      }
      vscode.window.setStatusBarMessage(result.message, 4000)
    })
  )
}
