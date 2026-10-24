'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageInfo = require('../package.json');
const {
  CompilerError,
  collectWatchPaths,
  compileDiagram,
} = require('./compiler');

const DEFAULT_DEBOUNCE_MS = 100;

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

function run(argv) {
  let options;

  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`[mmdcompiler] ${error.message}`);
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.version) {
    console.log(packageInfo.version);
    return 0;
  }

  const compile = function compile() {
    try {
      const result = compileDiagram(options);
      const action = result.changed ? 'Compiled' : 'Checked';
      console.log(
        `[mmdcompiler] ${action} ${path.relative(process.cwd(), result.inputPath)} -> ${path.relative(process.cwd(), result.outputPath)} `
        + `(${result.classes} class${result.classes === 1 ? '' : 'es'}, ${result.files.length} file${result.files.length === 1 ? '' : 's'})`,
      );
      return result;
    } catch (error) {
      printError(error);
      return null;
    }
  };

  if (!options.watch) {
    const firstResult = compile();
    return firstResult ? 0 : 1;
  }

  const watcher = new WatchRunner(options, compile);
  watcher.start(collectWatchPaths(options.inputPath));
  const firstResult = compile();
  watcher.update(firstResult ? firstResult.files : collectWatchPaths(options.inputPath));

  const stop = function stop() {
    watcher.close();
    process.exit(0);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log('[mmdcompiler] Watching for changes. Press Ctrl+C to stop.');
  return 0;
}

function parseArguments(argv) {
  const options = {
    debounceMs: DEFAULT_DEBOUNCE_MS,
    help: false,
    inputPath: null,
    outputPath: null,
    version: false,
    watch: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '-v' || argument === '--version') {
      options.version = true;
      continue;
    }
    if (argument === '--watch') {
      options.watch = true;
      continue;
    }
    if (argument === '--once' || argument === '--no-watch') {
      options.watch = false;
      continue;
    }
    if (argument === '-i' || argument === '--input') {
      options.inputPath = nextArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '-o' || argument === '--output') {
      options.outputPath = nextArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--debounce') {
      options.debounceMs = parseDebounce(nextArgument(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument.startsWith('--input=')) {
      options.inputPath = argument.slice('--input='.length);
      continue;
    }
    if (argument.startsWith('--output=')) {
      options.outputPath = argument.slice('--output='.length);
      continue;
    }
    if (argument.startsWith('--debounce=')) {
      options.debounceMs = parseDebounce(argument.slice('--debounce='.length));
      continue;
    }

    throw new CliError(`Unknown option: ${argument}`);
  }

  if (!options.help && !options.version) {
    if (!options.inputPath) {
      throw new CliError('Missing input file.');
    }
    if (!options.outputPath) {
      throw new CliError('Missing output file.');
    }
  }

  return options;
}

function nextArgument(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliError(`Option ${option} requires a value.`);
  }
  return value;
}

function parseDebounce(value) {
  if (!/^\d+$/.test(value)) {
    throw new CliError('Debounce must be a non-negative integer in milliseconds.');
  }
  return Number(value);
}

function usage() {
  return [
    'Usage: mmdcompiler -i <input.mmd> -o <output.mmd> [options]',
    '',
    'The compiler watches the input and all imported files by default.',
    '',
    'Options:',
    '  -i, --input <file>       Entry Mermaid file',
    '  -o, --output <file>      Generated Mermaid file',
    '      --once               Compile once and exit',
    '      --watch              Keep watching (default)',
    '      --debounce <ms>      Wait before recompiling (default: 100)',
    '  -h, --help               Show this help',
    '  -v, --version            Show the version',
  ].join('\n');
}

function printError(error) {
  if (error instanceof CompilerError || error instanceof CliError) {
    console.error(`[mmdcompiler] ${error.message}`);
    return;
  }
  console.error(`[mmdcompiler] Unexpected error: ${error.stack || error.message || error}`);
}

class WatchRunner {
  constructor(options, compile) {
    this.options = options;
    this.compile = compile;
    this.directoryWatchers = [];
    this.timer = null;
    this.running = false;
  }

  start(paths) {
    this.running = true;
    this.update(paths);
  }

  update(paths) {
    this.closeWatchers();

    const directoryTargets = new Map();
    for (const filePath of paths) {
      const resolvedPath = path.resolve(filePath);
      const watchTarget = findExistingWatchDirectory(path.dirname(resolvedPath));
      if (!directoryTargets.has(watchTarget.path)) {
        directoryTargets.set(watchTarget.path, {
          names: new Set(),
          watchAny: false,
        });
      }

      const target = directoryTargets.get(watchTarget.path);
      if (watchTarget.path === path.dirname(resolvedPath)) {
        target.names.add(path.basename(resolvedPath));
      } else {
        target.watchAny = true;
      }
    }

    for (const [directory, target] of directoryTargets) {
      try {
        const watcher = fs.watch(directory, (eventType, filename) => {
          if (!this.running) {
            return;
          }

          if (target.watchAny || !filename || target.names.has(filename.toString())) {
            this.schedule(`${eventType}: ${filename || directory}`);
          }
        });
        this.directoryWatchers.push(watcher);
      } catch (error) {
        console.error(`[mmdcompiler] Unable to watch ${directory}: ${error.message}`);
      }
    }
  }

  schedule(reason) {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) {
        return;
      }

      if (reason) {
        console.log(`[mmdcompiler] Change detected (${reason})`);
      }

      const result = this.compile();
      this.update(result ? result.files : collectWatchPaths(this.options.inputPath));
    }, this.options.debounceMs);
  }

  closeWatchers() {
    for (const watcher of this.directoryWatchers) {
      watcher.close();
    }
    this.directoryWatchers = [];
  }

  close() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closeWatchers();
  }
}

function findExistingWatchDirectory(directory) {
  let current = path.resolve(directory);

  while (!isDirectory(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return { path: current };
    }
    current = parent;
  }

  return { path: current };
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  parseArguments,
  run,
  usage,
};
