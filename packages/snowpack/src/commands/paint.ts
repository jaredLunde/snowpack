import detectPort from 'detect-port';
import {EventEmitter} from 'events';
import * as colors from 'kleur/colors';
import path from 'path';
import readline from 'readline';
const cwd = process.cwd();

export const paintEvent = {
  BUILD_FILE: 'BUILD_FILE',
  ERROR: 'ERROR',
  INFO: 'INFO',
  NEW_SESSION: 'NEW_SESSION',
  SERVER_RESPONSE: 'SERVER_RESPONSE',
  SERVER_START: 'SERVER_START',
  WARN: 'WARN',
  WORKER_COMPLETE: 'WORKER_COMPLETE',
  WORKER_MSG: 'WORKER_MSG',
  WORKER_RESET: 'WORKER_RESET',
  WORKER_UPDATE: 'WORKER_UPDATE',
};

/** Human-friendly name for CLI commands */
const displayName = {
  tsc: 'TypeScript',
};

/**
 * Get the actual port, based on the `defaultPort`.
 * If the default port was not available, then we'll prompt the user if its okay
 * to use the next available port.
 */
export async function getPort(defaultPort: number): Promise<number> {
  const bestAvailablePort = await detectPort(defaultPort);
  if (defaultPort !== bestAvailablePort) {
    let useNextPort: boolean = false;
    if (process.stdout.isTTY) {
      const rl = readline.createInterface({input: process.stdin, output: process.stdout});
      useNextPort = await new Promise((resolve) => {
        rl.question(
          colors.yellow(
            `! Port ${colors.bold(defaultPort)} not available. Run on port ${colors.bold(
              bestAvailablePort,
            )} instead? (Y/n) `,
          ),
          (answer) => {
            resolve(!/^no?$/i.test(answer));
          },
        );
      });
      rl.close();
    }
    if (!useNextPort) {
      console.error(
        colors.red(
          `✘ Port ${colors.bold(defaultPort)} not available. Use ${colors.bold(
            '--port',
          )} to specify a different port.`,
        ),
      );
      console.error();
      process.exit(1);
    }
  }
  return bestAvailablePort;
}

interface WorkerState {
  done: boolean;
  state: null | [string, string];
  error: null | Error;
  output: string;
}
const WORKER_BASE_STATE: WorkerState = {done: false, error: null, state: null, output: ''};

/** If output isn’t important, hide it (”0 errors,” etc.) */
function hideOutput(cmd: string, stdout: string): boolean {
  switch (cmd) {
    case 'svelte-check': {
      return stdout.includes('found no errors');
    }
    case 'tsc': {
      return stdout.includes('Found 0 errors.');
    }
    default: {
      return false;
    }
  }
}

export function paint(bus: EventEmitter, plugins: string[]) {
  let port: number;
  let hostname: string;
  let protocol = '';
  let startTimeMs: number;
  let ips: string[] = [];
  let consoleOutput: string[] = [];
  let installOutput = '';
  let isInstalling = false;
  const allWorkerStates: Record<string, WorkerState> = {};
  const allFileBuilds = new Set<string>();

  for (const plugin of plugins) {
    allWorkerStates[plugin] = {...WORKER_BASE_STATE};
  }

  function setupWorker(id: string) {
    if (!allWorkerStates[id]) {
      allWorkerStates[id] = {...WORKER_BASE_STATE};
    }
  }

  function repaint() {
    // Clear Page
    process.stdout.write(process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H');

    // Print the Console
    if (consoleOutput.length) {
      process.stdout.write(`${colors.underline(colors.bold('▼ Console'))}\n\n`);
      process.stdout.write(consoleOutput.join('\n  '));
      process.stdout.write('\n\n');
    }

    // Print the Workers
    for (const [script, workerState] of Object.entries(allWorkerStates)) {
      if (workerState.output && !hideOutput(script, workerState.output)) {
        const colorsFn = Array.isArray(workerState.error) ? colors.red : colors.reset;
        process.stdout.write(
          `${colorsFn(colors.underline(colors.bold('▼ ' + displayName[script] || script)))}\n\n`,
        );
        process.stdout.write(workerState.output.trim().replace(/\n/gm, '\n  '));
        process.stdout.write('\n\n');
      }
    }

    // Dashboard
    const isServerStarted = startTimeMs > 0 && port > 0 && protocol;
    if (isServerStarted) {
      if (allFileBuilds.size > 0) {
        process.stdout.write(colors.dim(` Building…`));
      }
      process.stdout.write(
        `${colors.bgBlue(colors.white(' SNOWPACK '))}${colors.bgGreen(
          colors.black(' READY '),
        )} ${hostname}:${port} › ${ips[0]}`,
      );
    } else {
      process.stdout.write(
        `${colors.bgBlue(colors.white(' SNOWPACK '))}${colors.bgYellow(colors.black(' LOADING '))}`,
      );
    }

    if (isInstalling) {
      process.stdout.write(`${colors.underline(colors.bold('▼ snowpack install'))}\n\n`);
      process.stdout.write('  ' + installOutput.trim().replace(/\n/gm, '\n  '));
      process.stdout.write('\n\n');
      return;
    }
  }

  /*
      import 'react';
      // snowpack fetches this from the CDN
      // saves it into a local cache - /Cache/snowpack/cdn/-/react-v16.13.1-hawhegawigawigahiw/react.js
      // Snowpack would serve it directly out of that cache
      // Snowpack would serve anything `/web_modules/*` out of `/Cache/snowpack/cdn/-/*`
    */

  /*

      TODO:
      - Cleaning this UI up a bit
        - What is the "empty state" / "start state" of this dev console?
        - First line? "Waiting for changes..."
        - can we make our default workers more concise?
        - indenting within a section?
        - get the console logs to match the pino logger
      - cleaning up dev.ts a bit
        - getting rid of messageBus things we no longer care about
        - what is the message bus?
        - what is the run()->dev console interface? `{paint: (action: 'CLEAR' | 'PAINT', str: string)}`

        */

  bus.on(paintEvent.BUILD_FILE, ({id, isBuilding}) => {
    if (isBuilding) {
      allFileBuilds.add(path.relative(cwd, id));
    } else {
      allFileBuilds.delete(path.relative(cwd, id));
    }
    repaint();
  });
  bus.on(paintEvent.WORKER_MSG, ({id, msg}) => {
    setupWorker(id);
    allWorkerStates[id].output += msg;
    repaint();
  });
  bus.on(paintEvent.WORKER_UPDATE, ({id, state}) => {
    if (typeof state !== undefined) {
      setupWorker(id);
      allWorkerStates[id].state = state;
    }
    repaint();
  });
  bus.on(paintEvent.WORKER_COMPLETE, ({id, error}) => {
    allWorkerStates[id].state = ['DONE', 'green'];
    allWorkerStates[id].done = true;
    allWorkerStates[id].error = allWorkerStates[id].error || error;
    repaint();
  });
  bus.on(paintEvent.WORKER_RESET, ({id}) => {
    allWorkerStates[id] = {...WORKER_BASE_STATE};
    repaint();
  });
  bus.on('INFO', ({args}) => {
    consoleOutput.push(args);
    repaint();
  });
  bus.on('WARN', ({args}) => {
    consoleOutput.push(args);
    repaint();
  });
  bus.on('ERROR', ({args}) => {
    consoleOutput.push(args);
    repaint();
  });
  bus.on(paintEvent.SERVER_START, (info) => {
    startTimeMs = info.startTimeMs;
    hostname = info.hostname;
    port = info.port;
    protocol = info.protocol;
    ips = info.ips;
    repaint();
  });

  repaint();
}
