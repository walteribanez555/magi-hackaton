import type { FileTier, LineKind } from '@magicode/contracts';
import { normalizeLine } from './hash.js';

/**
 * Clasificación HEURÍSTICA (regex por familia de lenguaje, no un parser) de líneas y archivos.
 * Ver docs/metrics-model.md §2.1. Limitaciones conocidas: no hay estado entre líneas
 * (p. ej. los nombres dentro de un `import { a, b }` multilínea cuentan como `logic`, y el
 * cuerpo de un docstring/comentario de bloque multilínea solo se detecta si empieza con `*`).
 */

/** Familia de sintaxis usada por las heurísticas. */
export type LangFamily =
  | 'js'
  | 'python'
  | 'go'
  | 'java' // java, kotlin, scala, groovy
  | 'csharp'
  | 'rust'
  | 'c' // c, c++, objective-c
  | 'php'
  | 'ruby'
  | 'shell' // sh, bash, zsh, powershell, dockerfile, makefile
  | 'sql' // sql, lua, haskell (comentario `--`)
  | 'hcl' // terraform
  | 'config' // json, yaml, toml, ini, env, properties, xml
  | 'markdown' // md, mdx, rst, txt
  | 'html'
  | 'css'
  | 'unknown';

const EXT_FAMILY: Record<string, LangFamily> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  py: 'python', pyi: 'python', pyw: 'python',
  go: 'go',
  java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', gradle: 'java', swift: 'java', dart: 'java',
  cs: 'csharp',
  rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  php: 'php',
  rb: 'ruby', rake: 'ruby',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell', mk: 'shell',
  sql: 'sql', lua: 'sql', hs: 'sql',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  json: 'config', jsonc: 'config', json5: 'config', yaml: 'config', yml: 'config', toml: 'config',
  ini: 'config', cfg: 'config', conf: 'config', env: 'config', properties: 'config', xml: 'config',
  plist: 'config', editorconfig: 'config', npmrc: 'config', lock: 'config',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'markdown', txt: 'markdown', adoc: 'markdown',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
};

/** languageId de VS Code → familia. */
const LANG_FAMILY: Record<string, LangFamily> = {
  typescript: 'js', typescriptreact: 'js', javascript: 'js', javascriptreact: 'js', vue: 'js', svelte: 'js',
  python: 'python',
  go: 'go',
  java: 'java', kotlin: 'java', scala: 'java', groovy: 'java', swift: 'java', dart: 'java',
  csharp: 'csharp',
  rust: 'rust',
  c: 'c', cpp: 'c', 'objective-c': 'c', 'objective-cpp': 'c',
  php: 'php',
  ruby: 'ruby',
  shellscript: 'shell', powershell: 'shell', dockerfile: 'shell', makefile: 'shell',
  sql: 'sql', lua: 'sql', haskell: 'sql',
  terraform: 'hcl', hcl: 'hcl',
  json: 'config', jsonc: 'config', json5: 'config', yaml: 'config', toml: 'config', ini: 'config',
  dotenv: 'config', properties: 'config', xml: 'config', 'github-actions-workflow': 'config',
  markdown: 'markdown', mdx: 'markdown', restructuredtext: 'markdown', plaintext: 'markdown',
  html: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
};

/** Extensión → languageId de VS Code (para completar FileChange.language). */
const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', go: 'go', java: 'java', kt: 'kotlin', scala: 'scala', swift: 'swift', cs: 'csharp',
  rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', php: 'php', rb: 'ruby',
  sh: 'shellscript', bash: 'shellscript', sql: 'sql', lua: 'lua', tf: 'terraform',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', env: 'dotenv',
  properties: 'properties', xml: 'xml', md: 'markdown', mdx: 'mdx', html: 'html',
  css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
};

function basename(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1);
}

function extension(path: string): string {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

/** Familia de sintaxis a partir de languageId (si se conoce) o de la ruta. */
export function languageFamily(path: string, language?: string): LangFamily {
  if (language) {
    const fam = LANG_FAMILY[language.toLowerCase()];
    if (fam) return fam;
  }
  const base = basename(path).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'config';
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base === 'makefile') return 'shell';
  if (base === 'jenkinsfile') return 'java';
  if (base === 'gemfile' || base === 'rakefile') return 'ruby';
  return EXT_FAMILY[extension(path)] ?? 'unknown';
}

/** languageId estilo VS Code deducido de la extensión (undefined si no se reconoce). */
export function detectLanguage(path: string): string | undefined {
  const base = basename(path).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  return EXT_LANGUAGE[extension(path)];
}

// ── tier de archivo ──────────────────────────────────────────────────────────────

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
  'flake.lock', 'packages.lock.json', 'podfile.lock', 'mix.lock', 'pubspec.lock',
]);

const GENERATED_DIRS = /(^|\/)(dist|build|out|coverage|node_modules|\.next|\.nuxt|\.turbo|target\/(debug|release)|__generated__|generated)\//;
const GENERATED_FILES = /(\.g\.[^/]+|\.generated\.[^/]+|\.min\.(js|css)|\.map|\.snap|\.pb\.go|_pb2\.pyi?|\.d\.ts\.map|_generated\.\w+)$/;
const TEST_FILES = /(\.(test|spec)\.[^/]+|_test\.(go|py|rb|exs?)|_spec\.rb|(^|\/)test_[^/]+\.py|Tests?\.(cs|java|kt|swift))$/;
const TEST_DIRS = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|cypress|playwright|testdata|fixtures)\//;
const INFRA = /(^|\/)(infra|infrastructure|terraform|deploy|deployment|k8s|kubernetes|helm|charts|ansible|\.github|\.gitlab|\.circleci|\.buildkite)\/|(^|\/)(dockerfile[^/]*|containerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml|buildspec\.ya?ml|serverless\.ya?ml|template\.ya?ml|samconfig\.toml|cdk\.json|procfile|vercel\.json|netlify\.toml|fly\.toml)$|\.(tf|tfvars|hcl)$/;
const DOCS = /(^|\/)(docs?|documentation)\/|\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)(readme|changelog|license|contributing|authors|notice)(\.[^/]*)?$/;

/**
 * Tier del archivo por ruta (relativa al repo). Orden de precedencia:
 * generated → test → infra → docs → core. Así `dist/x.test.js` es generado y
 * `.github/PULL_REQUEST_TEMPLATE.md` es infra (no docs).
 */
export function fileTier(path: string): FileTier {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const lower = p.toLowerCase();
  const base = basename(lower);
  if (LOCKFILES.has(base) || GENERATED_DIRS.test(lower) || GENERATED_FILES.test(lower) || /(^|\/)__snapshots__\//.test(lower)) {
    return 'generated';
  }
  // TEST_FILES distingue mayúsculas en `FooTest.java`; se evalúa sobre la ruta original
  if (TEST_FILES.test(p) || TEST_FILES.test(lower) || TEST_DIRS.test(lower)) return 'test';
  if (INFRA.test(lower)) return 'infra';
  if (DOCS.test(lower)) return 'docs';
  return 'core';
}

/** Línea mecánica = la habría producido una herramienta determinista (sin LLM). */
export function isMechanical(kind: LineKind, tier: FileTier): boolean {
  return kind === 'import' || kind === 'trivial' || tier === 'generated';
}

// ── clasificación de línea ───────────────────────────────────────────────────────

/** Palabras que, solas entre puntuación, no aportan contenido (`} else {`, `end`, `fi`…). */
const TRIVIAL_WORDS = new Set([
  'else', 'end', 'fi', 'done', 'esac', 'then', 'do', 'begin', 'try', 'finally', 'pass',
  'endif', 'endfor', 'endwhile', 'endforeach', 'endfunction', 'endmodule', 'default', 'break',
]);

/**
 * Trivial: solo puntuación/corchetes, o una palabra de relleno entre puntuación
 * (`}`, `);`, `]`, `} else {`, `end`, `else:`, `try {`), separadores (`---`), cierres JSX
 * (`</div>`, `/>`) y delimitadores de comentario vacíos (`/**`, `*\/`, `"""`).
 * Decisión: `break;` y `default:` también se consideran triviales (relleno de switch).
 */
function isTrivial(n: string): boolean {
  if (/^[-=*_~#]{3,}$/.test(n)) return true; // separadores / front matter
  if (/^(\/\*\*?|\*\/|\*|"""|'''|<!--|-->|```\w*|~~~)$/.test(n)) return true;
  if (/^(<\/[\w.:-]*>|\/>|<>)[;,)]*$/.test(n)) return true;
  const stripped = n.replace(/[\s{}()[\];,.:]/g, '');
  if (stripped === '') return true;
  return TRIVIAL_WORDS.has(stripped.toLowerCase());
}

function isComment(n: string, fam: LangFamily): boolean {
  const slash = /^(\/\/|\/\*|\*\/|\*(\s|$))/;
  switch (fam) {
    case 'js':
    case 'java':
    case 'csharp':
    case 'go':
    case 'rust':
    case 'c':
    case 'css':
      return slash.test(n);
    case 'php':
    case 'hcl':
      return slash.test(n) || (n.startsWith('#') && !n.startsWith('#['));
    case 'python':
      return n.startsWith('#') || /^[rRbBuU]?("""|''')/.test(n);
    case 'ruby':
      return (n.startsWith('#') && !n.startsWith('#{')) || n.startsWith('=begin') || n.startsWith('=end');
    case 'shell':
      return n.startsWith('#');
    case 'sql':
      return n.startsWith('--') || slash.test(n);
    case 'html':
      return n.startsWith('<!--');
    case 'config':
      return n.startsWith('#') || n.startsWith('//') || n.startsWith(';') || n.startsWith('<!--');
    case 'markdown':
      return true;
    default:
      return slash.test(n) || (n.startsWith('#') && !/^#(include|import|define|if|ifdef|ifndef|endif|pragma|\[)/.test(n)) || /^--\s/.test(n);
  }
}

function isImport(n: string, fam: LangFamily): boolean {
  switch (fam) {
    case 'js':
      return (
        /^import(\s|\{|\*|'|")/.test(n) ||
        /^export\s+(type\s+)?(\*|\{[^}]*\})\s*(as\s+\w+\s+)?from\s/.test(n) ||
        /^export\s+\*\s+as\s+\w+\s+from\s/.test(n) ||
        /^\}\s*from\s+['"]/.test(n) ||
        /^(const|let|var)\s+[\w${}\s,:]+=\s*require\(['"][^'"]+['"]\)/.test(n) ||
        /^require\(['"][^'"]+['"]\);?$/.test(n) ||
        /^@import\s/.test(n)
      );
    case 'python':
      return /^import\s+[\w.]/.test(n) || /^from\s+[\w.]+\s+import\s/.test(n);
    case 'go':
      return /^(import|package)\s/.test(n) || /^import\s*\($/.test(n) || /^(\w+\s+|_\s+|\.\s+)?"[\w./-]+"$/.test(n);
    case 'java':
      return /^(import|package)\s+[\w.*]+(\s+as\s+\w+)?;?$/.test(n) || /^import\s+static\s/.test(n);
    case 'csharp':
      return /^(global\s+)?using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?;$/.test(n);
    case 'rust':
      return /^(pub(\([\w:]+\))?\s+)?use\s/.test(n) || /^extern\s+crate\s/.test(n) || /^(pub\s+)?mod\s+\w+;$/.test(n);
    case 'c':
      return /^#\s*(include|import)\b/.test(n) || /^@import\s/.test(n) || /^using\s+namespace\s/.test(n);
    case 'php':
      return /^(use|namespace)\s+[\w\\]+/.test(n) || /^(require|include)(_once)?[\s(]/.test(n);
    case 'ruby':
      return /^(require|require_relative|load)[\s(]/.test(n);
    case 'shell':
      return /^(source|\.)\s+\S+$/.test(n);
    case 'css':
      return /^@(import|use|forward)\s/.test(n);
    default:
      return (
        /^import\s/.test(n) ||
        /^from\s+[\w.]+\s+import\s/.test(n) ||
        /^#\s*include\b/.test(n) ||
        /^using\s+[\w.]+;$/.test(n) ||
        /^(const|let|var)\s+[\w{}\s,]+=\s*require\(/.test(n)
      );
  }
}

/** Aserciones / casos de prueba reconocibles fuera de archivos de test. */
const TEST_LINE =
  /^(describe|it|test|context|suite|beforeEach|afterEach|beforeAll|afterAll)(\.\w+)?\s*\(|\bexpect\s*\(|^assert\b|\bassert(Equals?|True|False|That|Null|NotNull|Throws|_eq|_ne)?!?\s*\(|\bself\.assert\w*\(|^Assert\.\w+\(|^#\[(tokio::)?test\]|^@(Test|ParameterizedTest|pytest\.\w+)\b|^\[(Test|Fact|Theory|TestMethod)\]|^func\s+Test\w*\(\w+\s+\*testing\.|\bt\.(Errorf|Fatalf?|Error|Run)\(|\b(require|assert)\.\w+\(t,|^def\s+test_\w*\(/;

const JS_DECL =
  /^(export\s+)?(default\s+)?(declare\s+)?((async\s+)?function\*?[\s(]|(abstract\s+)?class\s|interface\s|type\s+\w+.*=|(const\s+)?enum\s|namespace\s|module\s+[\w'"])|^(export\s+)?(default\s+)?(const|let|var)\s+\w+\s*(:\s*[^=]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(:\s*[^=]+)?=>|\w+\s*=>)|^((public|private|protected|static|readonly|abstract|override|async|get|set|declare)\s+)*(constructor|[\w$]+)\s*(<[^>]*>)?\s*\([^)]*\)\s*((:\s*[^{=]+)?\{|:\s*[^{=]+;?)$|^((public|private|protected|static|readonly|declare)\s+)*[\w$]+[?!]?\s*:\s*[^=]+;$|^@\w+/;
const CONTROL_WORDS = /^(if|for|while|switch|catch|with|return|await|yield|throw|new|typeof|else\s+if|\}\s*else|do|super|this|case|default)\b/;

const PY_DECL = /^(async\s+)?def\s+\w+|^class\s+\w+|^@[\w.]+/;
// func/type, `var x T` sin valor, campos de struct (`Name string \`json:"name"\``) y firmas de interfaz (`Close() error`)
const GO_DECL = /^func\s|^type\s+\w+|^(var|const)\s+\w+\s+[\w.*[\]]+$|^\w+\s+[\w.*[\]]+(\s+`[^`]*`)?$|^\w+\([^)]*\)\s+[\w.*[\](),\s]+$/;
const JAVA_MODS = '(public|private|protected|internal|static|final|abstract|sealed|override|virtual|async|partial|readonly|synchronized|native|open|data|suspend|inline|extern|unsafe|new)';
const JAVA_DECL = new RegExp(
  `^(${JAVA_MODS}\\s+)*(class|interface|enum|record|struct|object|trait|namespace|@interface)\\s+\\w+` +
    `|^(${JAVA_MODS}\\s+)*(fun|func|def)\\s+[\\w<>.]+` +
    `|^(${JAVA_MODS}\\s+)+[\\w<>\\[\\],.?\\s]+\\s+\\w+\\s*\\([^)]*\\)\\s*(throws\\s+[\\w.,\\s]+)?\\s*(\\{|;|=>.*)?$` +
    `|^(${JAVA_MODS}\\s+)+[\\w<>\\[\\],.?]+\\s+\\w+(\\s*\\{\\s*get;.*)?;?$` +
    `|^[\\w<>\\[\\],.?]+\\s+\\w+\\s*\\([^)]*\\)\\s*(throws\\s+[\\w.,\\s]+)?\\s*\\{$` +
    `|^@\\w+|^\\[\\w+(\\(.*\\))?\\]$`,
);
const RUST_DECL =
  /^(pub(\([\w:]+\))?\s+)?((async|unsafe|const|extern(\s+"\w+")?)\s+)*fn\s|^(pub(\([\w:]+\))?\s+)?(struct|enum|trait|type|union|mod|macro_rules!)\s|^(unsafe\s+)?impl\b|^#!?\[|^(pub(\([\w:]+\))?\s+)?\w+\s*:\s*[\w<>&'[\];\s,:]+,$/;
const C_DECL = /^#\s*define\b|^(typedef|struct|union|enum|class|namespace|template)\b|^(static\s+|inline\s+|extern\s+|const\s+|virtual\s+)*[\w:<>*&]+\s+[*&]?[\w:~]+\s*\([^)]*\)\s*(const)?\s*\{?$/;
const GENERIC_DECL = /^((export|public|private|static|pub|async)\s+)*(function|def|class|fn|func|fun|interface|struct|trait|type|module|sub|proc)\s+\w/;

function isDeclaration(n: string, fam: LangFamily): boolean {
  switch (fam) {
    case 'js':
      return !CONTROL_WORDS.test(n) && JS_DECL.test(n);
    case 'python':
      return PY_DECL.test(n);
    case 'go':
      return !CONTROL_WORDS.test(n) && GO_DECL.test(n) && !/^(return|break|continue|go|defer|goto)\b/.test(n);
    case 'java':
    case 'csharp':
      return !CONTROL_WORDS.test(n) && !/^(return|throw)\b/.test(n) && JAVA_DECL.test(n);
    case 'rust':
      return RUST_DECL.test(n);
    case 'c':
      return !CONTROL_WORDS.test(n) && C_DECL.test(n);
    case 'php':
      return /^((abstract|final|public|private|protected|static)\s+)*(function|class|interface|trait|enum)\s+\w/.test(n);
    case 'ruby':
      return /^(def|class|module)\s+\w/.test(n);
    case 'shell':
      return /^(function\s+\w+|\w+\s*\(\)\s*\{?)$/.test(n) || /^function\s+\w+/.test(n);
    case 'hcl':
      return /^(resource|module|variable|output|data|provider|locals|terraform)\b/.test(n);
    case 'sql':
      return /^(create|alter)\s+(table|view|index|function|procedure|type|schema)\b/i.test(n) || /^(local\s+)?function\s/.test(n);
    default:
      return GENERIC_DECL.test(n);
  }
}

/**
 * Clasifica una línea en un `LineKind`. Orden de decisión:
 * vacía/trivial → (config|markdown según familia) → comment → import → test → declaration → logic.
 * - Archivos de config (json/yaml/toml/ini/env/xml): comentarios → `comment`, resto no trivial → `config`.
 * - Markdown/texto: toda línea no trivial → `comment` (documentación).
 * - `test`: cualquier línea no trivial/comentario/import de un archivo de tier `test`, o líneas
 *   con forma de aserción/caso (`expect(`, `assert`, `it(`, `describe(`, `#[test]`, `@Test`…).
 * - Una línea vacía devuelve `trivial` (los conteos la excluyen antes de clasificar).
 */
export function classifyLine(line: string, ctx: { path: string; language?: string }): LineKind {
  const n = normalizeLine(line);
  if (n === '' || isTrivial(n)) return 'trivial';
  const fam = languageFamily(ctx.path, ctx.language);
  if (fam === 'config') return isComment(n, fam) ? 'comment' : 'config';
  if (fam === 'markdown') return 'comment';
  // shebang: no es comentario de valor, pero tampoco lógica — se trata como comentario
  if (n.startsWith('#!') && !n.startsWith('#![')) return 'comment';
  if (isComment(n, fam)) return 'comment';
  if (isImport(n, fam)) return 'import';
  if (fileTier(ctx.path) === 'test' || TEST_LINE.test(n)) return 'test';
  if (isDeclaration(n, fam)) return 'declaration';
  return 'logic';
}
