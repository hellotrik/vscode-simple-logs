import * as vscode from 'vscode'
import { File } from './file'
import { getActiveEditor } from './utils'
import { registerTagFeatures } from './tag/registerTags'

const fileInstance: File = File.getInstance()

export async function activate(context: vscode.ExtensionContext) {
  registerTagFeatures(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('simple-logs.clearCache', () => {
      fileInstance.clearCache(true)
    })
  )

  const editor = getActiveEditor()
  if (editor) {
    fileInstance.handlerFile(editor.document.fileName)
  }
}

export function deactivate() {
  fileInstance.dispose()
}
