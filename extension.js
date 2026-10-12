'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { findDeclarations, findDefinitions } = require('./parser');

let checkDecoration, missingDecoration;
const pending = new Map();
const HEADER_RE = /\.(h|hh|hpp|hxx)$/i;
const SOURCE_RE = /\.(cpp|cc|cxx|c)$/i;

async function locateSource(headerUri) {
  const folder = path.dirname(headerUri.fsPath);
  const stem = path.basename(headerUri.fsPath, path.extname(headerUri.fsPath));
  const exts = vscode.workspace.getConfiguration('cppImplementationIndicator').get('sourceExtensions', ['.cpp', '.cc', '.cxx', '.c']);
  for (const ext of exts) {
    const candidate = path.join(folder, stem + ext);
    if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
  }
  if (vscode.workspace.getConfiguration('cppImplementationIndicator').get('searchWorkspace', true)) {
    const pattern = `**/${stem}{${exts.join(',')}}`;
    const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,build,out}/**', 200);
    if (files.length) return files[0];
  }
  return null;
}

async function getText(uri) {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try { return fs.readFileSync(uri.fsPath, 'utf8'); }
  catch (e) { return ''; }
}

async function updateEditor(editor) {
  if (!editor || !HEADER_RE.test(editor.document.uri.fsPath)) return;
  const uri = editor.document.uri;
  const key = uri.toString();
  if (pending.has(key)) clearTimeout(pending.get(key));
  pending.set(key, setTimeout(async () => {
    try {
      // Don't paint stale results into an editor that has changed documents.
      if (editor.document.uri.toString() !== key) return;
      const headerText = editor.document.getText();
      const declarations = findDeclarations(headerText);
      if (!declarations.length) {
        editor.setDecorations(checkDecoration, []);
        editor.setDecorations(missingDecoration, []);
        return;
      }
      const sourceUri = await locateSource(uri);
      const sourceText = sourceUri ? await getText(sourceUri) : '';
      const classNames = new Set(declarations.map(d => d.className).filter(Boolean));
      const definitions = new Set([
        ...findDefinitions(headerText, classNames),
        ...(sourceText ? findDefinitions(sourceText, classNames) : [])
      ]);
      const good = [], bad = [];
      for (const d of declarations) {
        if (editor.document.uri.toString() !== key) return;
        const lineNumber = Math.max(0, Math.min(d.line, editor.document.lineCount - 1));
        const line = editor.document.lineAt(lineNumber);
        const range = new vscode.Range(line.range.start, line.range.start);
        const implemented = definitions.has(d.scopeKey || `${d.className}::${d.key}`);
        const where = sourceUri ? ` in ${path.basename(sourceUri.fsPath)}` : ' in a matching source file';
        const item = {
          range,
          hoverMessage: implemented
            ? `Matching definition found${sourceUri ? ` in ${path.basename(sourceUri.fsPath)}` : ' in this header'}.`
            : `No matching definition was recognized${where}. This is a heuristic check; complex C++ syntax may not be recognized.`
        };
        (implemented ? good : bad).push(item);
      }
      editor.setDecorations(checkDecoration, good);
      editor.setDecorations(missingDecoration, bad);
    } catch (err) {
      console.error('[C++ Implementation Indicator] Analysis failed:', err);
      vscode.window.setStatusBarMessage('C++ Implementation Indicator: analysis failed; see Developer Tools console.', 5000);
    }
  }, 100));
}

function refreshAll() {
  for (const editor of vscode.window.visibleTextEditors) updateEditor(editor);
}

function activate(context) {
  const resources = path.join(context.extensionPath, 'resources');
  checkDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(path.join(resources, 'check.svg')),
    gutterIconSize: 'contain'
  });
  missingDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(path.join(resources, 'cross.svg')),
    gutterIconSize: 'contain'
  });
  context.subscriptions.push(checkDecoration, missingDecoration);
  context.subscriptions.push(vscode.commands.registerCommand('cppImplementationIndicator.refresh', refreshAll));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateEditor));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const changed = event.document.uri.fsPath;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === event.document.uri.toString() || SOURCE_RE.test(changed)) updateEditor(editor);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => refreshAll()));
  refreshAll();
}
function deactivate() {}
module.exports = { activate, deactivate };
