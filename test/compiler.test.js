'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CompilerError,
  compileDiagram,
} = require('../src/compiler');

const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

function createProject(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmdcompiler-'));
  temporaryDirectories.add(directory);
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(directory, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return directory;
}

function compileFixture(files) {
  const directory = createProject(files);
  const inputPath = path.join(directory, 'main.mmd');
  const outputPath = path.join(directory, 'generated.mmd');
  const result = compileDiagram({ inputPath, outputPath });
  return {
    content: fs.readFileSync(outputPath, 'utf8'),
    directory,
    result,
  };
}

test('follows dependency direction and excludes imported dependents', () => {
  const fixture = compileFixture({
    'main.mmd': `classDiagram
%%# import ./second.mmd
main --> INumber

class main {
  INumber children;
}
`,
    'second.mmd': `classDiagram
Second --|> INumber

class Second {
  bool isActive;
}

class INumber {
  int number;
}

class Some {
  string thing;
}
`,
  });

  assert.match(fixture.content, /class main/);
  assert.match(fixture.content, /class INumber/);
  assert.doesNotMatch(fixture.content, /class Second/);
  assert.doesNotMatch(fixture.content, /class Some/);
  assert.doesNotMatch(fixture.content, /Second --\|> INumber/);
});

test('includes transitive dependencies found in class members', () => {
  const fixture = compileFixture({
    'main.mmd': `classDiagram
%%# import ./types.mmd

class Main {
  Foo value;
}
`,
    'types.mmd': `classDiagram
class Foo {
  Bar value;
}

class Bar {
  string value;
}
`,
  });

  assert.match(fixture.content, /class Main/);
  assert.match(fixture.content, /class Foo/);
  assert.match(fixture.content, /class Bar/);
});

test('prefers a local definition over an imported duplicate', () => {
  const fixture = compileFixture({
    'main.mmd': `classDiagram
%%# import ./duplicate.mmd

class Foo {
  string localValue;
}
`,
    'duplicate.mmd': `classDiagram
class Foo {
  string importedValue;
}
`,
  });

  assert.match(fixture.content, /localValue/);
  assert.doesNotMatch(fixture.content, /importedValue/);
});

test('rejects circular imports', () => {
  const directory = createProject({
    'main.mmd': '%%# import ./second.mmd\nclassDiagram\n',
    'second.mmd': '%%# import ./main.mmd\nclassDiagram\n',
  });

  assert.throws(
    () => compileDiagram({
      inputPath: path.join(directory, 'main.mmd'),
      outputPath: path.join(directory, 'generated.mmd'),
    }),
    (error) => error instanceof CompilerError && error.code === 'CIRCULAR_IMPORT',
  );
});

test('watch mode recompiles after an input change', async () => {
  const directory = createProject({
    'main.mmd': `classDiagram
class Main {
  string original;
}
`,
  });
  const inputPath = path.join(directory, 'main.mmd');
  const outputPath = path.join(directory, 'generated.mmd');
  const cliPath = path.join(__dirname, '..', 'bin', 'mmdcompiler.js');
  const child = spawn(process.execPath, [
    cliPath,
    '-i',
    inputPath,
    '-o',
    outputPath,
    '--debounce',
    '25',
  ], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => {
    childOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childOutput += chunk.toString();
  });

  try {
    await waitForFile(outputPath, 'original');
    fs.writeFileSync(inputPath, `classDiagram
class Main {
  string changed;
}
`, 'utf8');
    try {
      await waitForFile(outputPath, 'changed');
    } catch (error) {
      error.message += `\nCLI output:\n${childOutput}`;
      throw error;
    }
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
});

function waitForFile(filePath, expectedText) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    function check() {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes(expectedText)) {
          resolve();
          return;
        }
      } catch {
        // The compiler may not have produced the first output yet.
      }

      if (Date.now() - startedAt > 4000) {
        reject(new Error(`Timed out waiting for ${expectedText} in ${filePath}`));
        return;
      }
      setTimeout(check, 25);
    }

    check();
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}
