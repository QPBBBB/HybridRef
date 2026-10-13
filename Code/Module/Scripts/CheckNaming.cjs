const Fs = require('node:fs')
const Path = require('node:path')
const Ts = require('typescript')

const ModuleRoot = Path.resolve(__dirname, '..')
const SourceRoots = ['Source', 'Scripts', 'E2E']
const ConfigurationFiles = ['vite.config.ts', 'vitest.config.ts', 'playwright.config.ts']
const CodeExtensions = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs'])
const SourceExtensions = new Set([...CodeExtensions, '.css', '.html'])
const Problems = []

function IsPascalCase(Name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(Name) && !/^[A-Z][A-Z0-9]+$/.test(Name)
}

function ListFiles(Directory) {
  return Fs.readdirSync(Directory, { withFileTypes: true }).flatMap(Entry => {
    const Filename = Path.join(Directory, Entry.name)
    return Entry.isDirectory() ? ListFiles(Filename) : Entry.isFile() ? [Filename] : []
  })
}

function CheckFilename(Filename) {
  const Extension = Path.extname(Filename)
  if (!SourceExtensions.has(Extension)) return
  const Stem = Path.basename(Filename).replace(/(?:\.d)?\.(?:ts|tsx|js|cjs|mjs|css|html)$/, '')
  if (!IsPascalCase(Stem)) Problems.push(`${Path.relative(ModuleRoot, Filename)}: filename must use PascalCase`)
}

function CheckCode(Filename) {
  if (!CodeExtensions.has(Path.extname(Filename))) return
  const Kind = Filename.endsWith('.tsx') ? Ts.ScriptKind.TSX : /\.(?:js|cjs|mjs)$/.test(Filename) ? Ts.ScriptKind.JS : Ts.ScriptKind.TS
  const SourceFile = Ts.createSourceFile(Filename, Fs.readFileSync(Filename, 'utf8'), Ts.ScriptTarget.Latest, true, Kind)

  function CheckName(Name) {
    // Property names supplied by browsers, libraries, YAML and HTTP are contracts.
    // Only declaration names and local import/destructuring bindings are checked.
    if (!Name || !Ts.isIdentifier(Name) || Name.text === 'this' || IsPascalCase(Name.text)) return
    const Position = SourceFile.getLineAndCharacterOfPosition(Name.getStart(SourceFile))
    Problems.push(`${Path.relative(ModuleRoot, Filename)}:${Position.line + 1}:${Position.character + 1}: ${Name.text} must use PascalCase`)
  }

  function Visit(Node) {
    if (Ts.isVariableDeclaration(Node) || Ts.isParameter(Node) || Ts.isBindingElement(Node)
      || Ts.isFunctionDeclaration(Node) || Ts.isFunctionExpression(Node)
      || Ts.isMethodDeclaration(Node) || Ts.isMethodSignature(Node)
      || Ts.isPropertyDeclaration(Node) || Ts.isGetAccessorDeclaration(Node) || Ts.isSetAccessorDeclaration(Node)
      || Ts.isImportClause(Node) || Ts.isImportSpecifier(Node) || Ts.isNamespaceImport(Node) || Ts.isImportEqualsDeclaration(Node)
      || Ts.isClassDeclaration(Node) || Ts.isClassExpression(Node) || Ts.isInterfaceDeclaration(Node)
      || Ts.isTypeAliasDeclaration(Node) || Ts.isTypeParameterDeclaration(Node) || Ts.isEnumDeclaration(Node) || Ts.isEnumMember(Node)) {
      CheckName(Node.name)
    }
    Ts.forEachChild(Node, Visit)
  }

  Visit(SourceFile)
}

for (const SourceRoot of SourceRoots) {
  const Directory = Path.join(ModuleRoot, SourceRoot)
  if (!Fs.existsSync(Directory)) {
    Problems.push(`${SourceRoot}: source directory is missing`)
    continue
  }
  for (const Filename of ListFiles(Directory)) {
    CheckFilename(Filename)
    CheckCode(Filename)
  }
}

// These names are required by the tools' standard configuration discovery.
for (const Filename of ConfigurationFiles) CheckCode(Path.join(ModuleRoot, Filename))

if (Problems.length) {
  console.error(`PascalCase naming check failed:\n${Problems.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('PascalCase naming check passed.')
}
