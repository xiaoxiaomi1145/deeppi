import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { arr, bool, compile, map, obj, opt, str } from '@earendil-works/pi-schema';

const MAX_TOOLS = 32;
const MAX_PARAMETERS = 16;
const MAX_SCRIPT_LENGTH = 16_384;
const IDENTIFIER = '^[A-Za-z_][A-Za-z0-9_-]{0,63}$';
const PROTOTYPE_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const BUILTINS = new Set(['bash', 'define_tool', 'list_tools', 'run_tool']);
const ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'PREFIX', 'TMPDIR', 'TMP', 'TEMP', 'TERM',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'SystemRoot', 'WINDIR', 'PATHEXT',
];

const shellCode = (description) => str({ description, minLength: 1, maxLength: MAX_SCRIPT_LENGTH });
const nameSchema = str({ pattern: IDENTIFIER });
const parameterSchema = obj({
  name: nameSchema,
  description: opt(str({ maxLength: 1_024 })),
  required: opt(bool({ description: 'Defaults to false. An omitted optional argument occupies its position as an empty string.' })),
});
const BASH_PARAMS = obj({ command: shellCode('Bash command or script to run in the session working directory.') });
const DEFINE_PARAMS = obj({
  name: nameSchema,
  description: str({ minLength: 1, maxLength: 1_024 }),
  parameters: opt(arr(parameterSchema, { maxItems: MAX_PARAMETERS, description: 'Parameters in positional argument order.' })),
  script: shellCode('Bash script. Read parameter values from "$1", "$2", and so on.'),
});
const LIST_PARAMS = obj({});
const RUN_PARAMS = obj({
  name: nameSchema,
  args: opt(map(str({ maxLength: MAX_SCRIPT_LENGTH }), { description: 'String argument values keyed by declared parameter name.' })),
});

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException('Bash tool call was aborted.', 'AbortError');
}

function childEnv() {
  const env = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function stopProcess(child, processGroup) {
  if (child.pid === undefined) return;
  if (processGroup) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error.code === 'ESRCH') return; // The process group has already ended.
    }
  }
  child.kill('SIGKILL');
}

/** Execute Bash with a working directory, under the server user's filesystem permissions. */
export async function runBash({ script, args = [], cwd, timeoutMs = 30_000, outputLimit = 24_000, signal }) {
  checkAbort(signal);
  if (typeof script !== 'string' || script.includes('\0')) throw new TypeError('Bash script must be a string without NUL bytes.');
  if (!Array.isArray(args) || [...args].some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('Bash arguments must be strings without NUL bytes.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Bash timeout must be between 1 and 2147483647 milliseconds.');
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) throw new RangeError('Bash output limit must be nonnegative.');

  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== 'win32';
    const child = spawn('bash', ['--noprofile', '--norc', '-c', script, 'deeppi', ...args], {
      cwd,
      env: childEnv(),
      detached: processGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const chunks = [];
    let size = 0;
    let truncated = false;
    let finished = false;
    const capture = (chunk) => {
      const count = Math.min(chunk.length, outputLimit - size);
      if (count > 0) {
        chunks.push(count === chunk.length ? chunk : Buffer.from(chunk.subarray(0, count)));
        size += count;
      }
      if (count < chunk.length) truncated = true;
    };
    const result = (exitCode, timedOut) => {
      const decoder = new StringDecoder('utf8');
      let text = decoder.write(Buffer.concat(chunks, size));
      if (!truncated) text += decoder.end();
      return { text, exitCode, timedOut, truncated };
    };
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const stop = () => {
      // Descendants can hold the pipes after the Bash leader exits.
      // Close the pipes in our process even if a descendant leaves the group.
      try {
        stopProcess(child, processGroup);
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    };
    const cancel = (aborted) => {
      if (!finish()) return;
      try {
        stop();
        if (aborted) reject(abortError());
        else resolve(result(null, true));
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => cancel(true);
    const timer = setTimeout(() => cancel(false), timeoutMs);

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      if (finish()) reject(error);
    });
    child.once('close', (exitCode) => {
      if (finish()) resolve(result(exitCode, false));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function toolResult(text, details) {
  return { content: [{ type: 'text', text }], details };
}

function commandResult(details) {
  const { text, exitCode, timedOut, truncated } = details;
  const output = [
    text || '(no output)',
    ...(truncated ? ['[Output truncated]'] : []),
    ...(timedOut ? ['[Bash timed out]'] : exitCode === null ? ['[Bash was terminated]'] : [`[Bash exit code: ${exitCode}]`]),
  ];
  return { ...toolResult(output.join('\n'), details), isError: timedOut || exitCode !== 0 };
}

function validateName(name, kind) {
  if (PROTOTYPE_NAMES.has(name) || (kind === 'tool' && BUILTINS.has(name))) {
    throw new Error(`Reserved ${kind} name: ${name}`);
  }
}

function validateScript(script) {
  if (!script.trim() || script.includes('\0')) throw new Error('Bash script must be nonblank and contain no NUL bytes.');
}

/** @returns {import('@earendil-works/pi-agent-core').AgentTool[]} */
export function createBashTools({ cwd, allowBash, bashTimeoutMs, maxToolOutput, registry, onRegistryChange }) {
  if (!allowBash) return [];

  const run = async (script, args, signal) => commandResult(await runBash({
    script, args, cwd, timeoutMs: bashTimeoutMs, outputLimit: maxToolOutput, signal,
  }));
  return [
    makeTool('bash', 'Bash', 'Run a Bash command in the session working directory with the server user’s permissions.', BASH_PARAMS,
      async ({ command }, signal) => {
        validateScript(command);
        return run(command, [], signal);
      }),
    makeTool('define_tool', 'Define Bash Tool', 'Create or replace a reusable Bash tool for this session. Call it with run_tool.', DEFINE_PARAMS,
      async ({ name, description, parameters = [], script }) => {
        validateName(name, 'tool');
        validateScript(script);
        if (!description.trim()) throw new Error('Tool description must be nonblank.');
        const names = new Set();
        for (const parameter of parameters) {
          validateName(parameter.name, 'parameter');
          if (names.has(parameter.name)) throw new Error(`Duplicate parameter: ${parameter.name}`);
          names.add(parameter.name);
        }

        const updating = Object.hasOwn(registry, name);
        if (!updating && Object.keys(registry).length >= MAX_TOOLS) throw new Error(`Reusable tool limit reached (${MAX_TOOLS}).`);
        const previous = updating ? registry[name] : undefined;
        registry[name] = { name, description, parameters: parameters.map((parameter) => ({ ...parameter })), script };
        try {
          onRegistryChange();
        } catch (error) {
          if (updating) registry[name] = previous;
          else delete registry[name];
          throw error;
        }
        return toolResult(`${updating ? 'Updated' : 'Defined'} reusable tool ${name}.`, { name, updated: updating });
      }, 'sequential'),
    makeTool('list_tools', 'List Bash Tools', 'List reusable Bash tools in this session and their declared parameters.', LIST_PARAMS,
      async () => {
        const tools = Object.values(registry).map(({ name, description, parameters }) => ({
          name, description, parameters: parameters.map((parameter) => ({ ...parameter })),
        }));
        return toolResult(tools.length ? JSON.stringify(tools) : 'No reusable Bash tools defined.', { tools });
      }),
    makeTool('run_tool', 'Run Bash Tool', 'Run a reusable Bash tool in this session with named string arguments.', RUN_PARAMS,
      async ({ name, args = {} }, signal) => {
        validateName(name, 'tool');
        if (!Object.hasOwn(registry, name)) throw new Error(`Unknown reusable tool: ${name}`);
        const { script, parameters } = registry[name];
        const names = new Set(parameters.map((parameter) => parameter.name));
        for (const key of Object.keys(args)) {
          if (!names.has(key)) throw new Error(`Unexpected argument for ${name}: ${key}`);
        }
        const positional = parameters.map(({ name: parameter, required }) => {
          if (Object.hasOwn(args, parameter)) return args[parameter];
          if (required) throw new Error(`Missing required argument for ${name}: ${parameter}`);
          return '';
        });
        return run(script, positional, signal);
      }),
  ];
}

function makeTool(name, label, description, parameters, execute, executionMode) {
  const validator = compile(parameters);
  const validate = (input) => {
    const result = validator.validate(input);
    if (result.ok) return result.value;
    const { path, message } = result.errors[0];
    throw new TypeError(`Invalid arguments for ${name}${path ? ` at ${path}` : ''}: ${message}`);
  };
  return {
    name, label, description, parameters,
    ...(executionMode && { executionMode }),
    prepareArguments: validate, // Check the raw call before Pi's coercing validation.
    async execute(_toolCallId, input, signal) {
      checkAbort(signal);
      return execute(validate(input), signal);
    },
  };
}
