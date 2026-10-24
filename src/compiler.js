'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMPORT_DIRECTIVE = /^\s*%%#\s*import\s+(.+?)\s*$/;
const CLASS_BLOCK_START = /^\s*class\s+([A-Za-z_][A-Za-z0-9_$.-]*)\s*\{/;
const CLASS_DECLARATION = /^\s*class\s+([A-Za-z_][A-Za-z0-9_$.-]*)\s*$/;
const RELATION_LINE = /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$.-]*))\s+([- .<>|o*]+?)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$.-]*))(?:\s*:.*)?\s*$/;
const NAME_TOKEN = /[A-Za-z_][A-Za-z0-9_$.-]*/g;

class CompilerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CompilerError';
    this.code = code || 'COMPILATION_ERROR';
  }
}

function compileDiagram(options) {
  validateCompileOptions(options);

  const inputPath = canonicalPath(options.inputPath);
  const outputPath = path.resolve(options.outputPath);

  if (inputPath === canonicalPath(outputPath)) {
    throw new CompilerError('The input and output files must be different.', 'INVALID_OUTPUT');
  }

  const project = loadProject(inputPath);
  const selection = selectClasses(project);
  const output = renderProject(project, selection);
  const previousOutput = readOptionalFile(outputPath);
  const changed = previousOutput !== output;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (changed) {
    fs.writeFileSync(outputPath, output, 'utf8');
  }

  return {
    changed,
    classes: selection.selected.size,
    files: project.paths.slice(),
    inputPath,
    outputPath,
    content: output,
  };
}

function loadProject(inputPath) {
  const documents = new Map();
  const states = new Map();
  const paths = [];

  function visit(filePath, ancestry) {
    const resolvedPath = canonicalPath(filePath);
    const state = states.get(resolvedPath);

    if (state === 'visiting') {
      const cycleStart = ancestry.indexOf(resolvedPath);
      const cycle = ancestry.slice(cycleStart).concat(resolvedPath);
      throw new CompilerError(
        `Circular import detected: ${cycle.join(' -> ')}`,
        'CIRCULAR_IMPORT',
      );
    }

    if (state === 'done') {
      return;
    }

    const content = readRequiredFile(resolvedPath);
    const document = parseDocument(resolvedPath, content);

    states.set(resolvedPath, 'visiting');
    documents.set(resolvedPath, document);
    paths.push(resolvedPath);

    const nextAncestry = ancestry.concat(resolvedPath);
    for (const importedFile of document.imports) {
      if (path.isAbsolute(importedFile.specifier)) {
        throw new CompilerError(
          `Import paths must be relative: ${importedFile.specifier} in ${resolvedPath}:${importedFile.line}`,
          'ABSOLUTE_IMPORT',
        );
      }

      const dependencyPath = path.resolve(path.dirname(resolvedPath), importedFile.specifier);
      importedFile.resolvedPath = dependencyPath;
      visit(dependencyPath, nextAncestry);
    }

    states.set(resolvedPath, 'done');
  }

  visit(inputPath, []);

  return {
    documents,
    paths,
    rootPath: canonicalPath(inputPath),
  };
}

function parseDocument(filePath, content) {
  const lines = content.split(/\r?\n/);
  const imports = [];
  const items = [];
  const definitions = [];
  const relations = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    const importMatch = line.match(IMPORT_DIRECTIVE);

    if (importMatch) {
      imports.push({
        line: lineIndex + 1,
        specifier: normalizeImportSpecifier(importMatch[1]),
      });
      lineIndex += 1;
      continue;
    }

    const blockMatch = line.match(CLASS_BLOCK_START);
    if (blockMatch) {
      const endLineIndex = findClassBlockEnd(lines, lineIndex, filePath);
      const raw = lines.slice(lineIndex, endLineIndex + 1).join('\n');
      const openingBrace = raw.indexOf('{');
      const closingBrace = raw.lastIndexOf('}');
      const definition = {
        endLine: endLineIndex + 1,
        kind: 'definition',
        name: blockMatch[1],
        raw,
        startLine: lineIndex + 1,
        body: raw.slice(openingBrace + 1, closingBrace),
      };

      definitions.push(definition);
      items.push(definition);
      lineIndex = endLineIndex + 1;
      continue;
    }

    const declarationMatch = line.match(CLASS_DECLARATION);
    if (declarationMatch) {
      const definition = {
        body: '',
        endLine: lineIndex + 1,
        kind: 'definition',
        name: declarationMatch[1],
        raw: line,
        startLine: lineIndex + 1,
      };

      definitions.push(definition);
      items.push(definition);
      lineIndex += 1;
      continue;
    }

    const relation = parseRelationship(line, lineIndex + 1);
    if (relation) {
      relations.push(relation);
      items.push(relation);
      lineIndex += 1;
      continue;
    }

    items.push({
      kind: 'preamble',
      raw: line,
      startLine: lineIndex + 1,
    });
    lineIndex += 1;
  }

  return {
    definitions,
    filePath,
    imports,
    items,
    relations,
  };
}

function parseRelationship(line, lineNumber) {
  const match = line.match(RELATION_LINE);
  if (!match) {
    return null;
  }

  const left = match[1] || match[2];
  const operator = match[3].replace(/\s/g, '');
  const right = match[4] || match[5];
  const pointsLeft = operator.includes('<') && !operator.includes('>');
  const from = pointsLeft ? right : left;
  const to = pointsLeft ? left : right;

  return {
    from,
    kind: 'relation',
    left,
    line: lineNumber,
    operator,
    raw: line,
    right,
    to,
  };
}

function findClassBlockEnd(lines, startLineIndex, filePath) {
  let depth = 0;

  for (let lineIndex = startLineIndex; lineIndex < lines.length; lineIndex += 1) {
    depth += countBraces(lines[lineIndex]);
    if (depth <= 0) {
      return lineIndex;
    }
  }

  throw new CompilerError(
    `Unclosed class definition in ${filePath}:${startLineIndex + 1}`,
    'INVALID_CLASS_DEFINITION',
  );
}

function countBraces(line) {
  let count = 0;
  for (const character of line) {
    if (character === '{') {
      count += 1;
    } else if (character === '}') {
      count -= 1;
    }
  }
  return count;
}

function selectClasses(project) {
  const definitionIndex = indexDefinitions(project);
  const dependencies = new Map();

  function addDependency(from, to) {
    if (!dependencies.has(from)) {
      dependencies.set(from, new Set());
    }
    dependencies.get(from).add(to);
  }

  for (const filePath of project.paths) {
    const document = project.documents.get(filePath);

    for (const definition of document.definitions) {
      const winner = definitionIndex.get(definition.name);
      if (!winner || winner.definition !== definition) {
        continue;
      }

      for (const dependencyName of findKnownNames(definition.body, definitionIndex)) {
        if (dependencyName !== definition.name) {
          addDependency(definition.name, dependencyName);
        }
      }
    }

    for (const relation of document.relations) {
      addDependency(relation.from, relation.to);
    }
  }

  const selected = new Set();
  const queue = [];
  const rootDocument = project.documents.get(project.rootPath);

  function enqueue(name) {
    if (!selected.has(name)) {
      selected.add(name);
      queue.push(name);
    }
  }

  for (const definition of rootDocument.definitions) {
    enqueue(definition.name);
  }

  for (const relation of rootDocument.relations) {
    enqueue(relation.from);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currentDependencies = dependencies.get(current);
    if (!currentDependencies) {
      continue;
    }

    for (const dependency of currentDependencies) {
      enqueue(dependency);
    }
  }

  return {
    definitionIndex,
    selected,
  };
}

function indexDefinitions(project) {
  const index = new Map();

  for (const filePath of project.paths) {
    const document = project.documents.get(filePath);
    for (const definition of document.definitions) {
      if (!index.has(definition.name)) {
        index.set(definition.name, { definition, document });
      }
    }
  }

  return index;
}

function findKnownNames(text, definitionIndex) {
  const tokens = new Set(text.match(NAME_TOKEN) || []);
  const names = [];

  for (const name of definitionIndex.keys()) {
    if (tokens.has(name)) {
      names.push(name);
    }
  }

  return names;
}

function renderProject(project, selection) {
  const chunks = [];
  const seenRelations = new Set();
  const rootDocument = project.documents.get(project.rootPath);

  for (const item of rootDocument.items) {
    if (item.kind === 'preamble' && item.raw.trim() !== '') {
      chunks.push(item.raw.trim());
    }
  }

  for (const filePath of project.paths) {
    const document = project.documents.get(filePath);

    for (const item of document.items) {
      if (item.kind === 'definition') {
        const winner = selection.definitionIndex.get(item.name);
        if (selection.selected.has(item.name) && winner && winner.definition === item) {
          chunks.push(item.raw.trim());
        }
        continue;
      }

      if (item.kind === 'relation') {
        if (!selection.selected.has(item.left) || !selection.selected.has(item.right)) {
          continue;
        }

        const relationKey = normalizeWhitespace(item.raw);
        if (!seenRelations.has(relationKey)) {
          seenRelations.add(relationKey);
          chunks.push(item.raw.trim());
        }
      }
    }
  }

  if (chunks.length === 0) {
    return '';
  }

  return `${chunks.join('\n\n')}\n`;
}

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function collectWatchPaths(inputPath) {
  const paths = new Set();
  const visited = new Set();

  function visit(filePath) {
    const resolvedPath = path.resolve(filePath);
    paths.add(resolvedPath);

    const identity = canonicalPath(resolvedPath);
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);

    if (!isFile(resolvedPath)) {
      return;
    }

    let content;
    try {
      content = fs.readFileSync(resolvedPath, 'utf8');
    } catch {
      return;
    }

    for (const specifier of extractImportSpecifiers(content)) {
      if (!path.isAbsolute(specifier)) {
        visit(path.resolve(path.dirname(resolvedPath), specifier));
      }
    }
  }

  visit(inputPath);
  return Array.from(paths);
}

function extractImportSpecifiers(content) {
  const specifiers = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(IMPORT_DIRECTIVE);
    if (match) {
      specifiers.push(normalizeImportSpecifier(match[1]));
    }
  }
  return specifiers;
}

function normalizeImportSpecifier(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function canonicalPath(filePath) {
  const absolutePath = path.resolve(filePath);
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function readRequiredFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CompilerError(`Unable to read Mermaid file ${filePath}: ${error.message}`, 'FILE_ERROR');
  }
}

function readOptionalFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function validateCompileOptions(options) {
  if (!options || typeof options.inputPath !== 'string' || options.inputPath.trim() === '') {
    throw new CompilerError('An input Mermaid file is required.', 'INVALID_INPUT');
  }
  if (typeof options.outputPath !== 'string' || options.outputPath.trim() === '') {
    throw new CompilerError('An output Mermaid file is required.', 'INVALID_OUTPUT');
  }
}

module.exports = {
  CompilerError,
  collectWatchPaths,
  compileDiagram,
  loadProject,
  parseDocument,
};
