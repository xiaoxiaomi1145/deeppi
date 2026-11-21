import { AppError, plainObject } from '../settings.mjs';

const toggleEntry = 'deeppi:addon-toggle-v1';
const definitionEntry = 'deeppi:bash-definition-v1';
const wrappers = {
  define_tool: 'Create or replace a reusable Bash tool for this session branch. Execute it with deeppi_run_tool.',
  list_tools: 'List reusable Bash tools for this session branch and their declared arguments.',
  run_tool: 'Run a reusable Bash tool in the Pi working directory with the local user’s permissions.',
};
const wrappedName = name => `deeppi_${name}`;
const owns = (entry, customType) => entry.type === 'custom' && entry.customType === customType;
const allowedBash = data => data.enabled === true && data.confirmed === true;
const scopeOf = ({ sessionManager, cwd }) => JSON.stringify([sessionManager.getSessionId(), sessionManager.getSessionFile(), cwd]);
const waitForIdle = ctx => {
  if (!ctx.isIdle()) throw new AppError(409, 'Wait for the current Pi operation to finish.');
};

function compactInstructions(focus) {
  const objective = typeof focus === 'string' ? focus.trim().slice(0, 8000) : '';
  return [
    'Prefer a concise, factual continuity summary that lets the next turn resume the task.',
    'Preserve user goals and constraints, decisions and why, affected files and exact paths, verified results, unresolved errors, and pending work with its next steps.',
    'Distinguish verified outcomes from guesses. Do not perform new work or repeat the dialogue.',
    objective && `Pay particular attention to the user’s focus: ${objective}`,
  ].filter(Boolean).join('\n');
}

/** An optional Pi extension shared by the TUI and Deeppi's Web bridge. */
export function createPiAddons(pi) {
  let current, loadBash, boundScope;
  let revision = 0, closed = false;
  let pending = Promise.resolve();
  const registered = new Set();

  const snapshot = () => ({ compact: current?.compact ?? false, bash: current?.bash ?? false });
  const assertCurrent = (ctx, scope, epoch) => {
    if (closed || epoch !== revision || (boundScope && scope !== boundScope) || scope !== scopeOf(ctx)) {
      throw new AppError(409, 'The active Pi session changed.');
    }
  };
  const schedule = (ctx, action) => {
    const scope = scopeOf(ctx), epoch = revision;
    const promise = pending.then(() => {
      assertCurrent(ctx, scope, epoch);
      return action(scope, epoch);
    });
    pending = promise.catch(() => {});
    return promise;
  };
  const invalidate = () => {
    revision++;
    const previous = current;
    current = undefined;
    previous?.controller.abort();
  };

  function activateBash(enabled) {
    if (!registered.size) return;
    const before = pi.getActiveTools();
    const after = enabled ? [...new Set([...before, ...registered])] : before.filter(name => !registered.has(name));
    if (before.length !== after.length) pi.setActiveTools(after);
    if (enabled && [...registered].some(name => !pi.getActiveTools().includes(name))) {
      activateBash(false);
      throw new AppError(409, 'The current Pi tool selection excludes the Deeppi Bash add-on tools.');
    }
  }

  function registerWrappers(tools) {
    const existing = new Set(pi.getAllTools().map(tool => tool.name));
    for (const name of Object.keys(wrappers).map(wrappedName)) {
      if (!registered.has(name) && existing.has(name)) throw new AppError(409, `Pi already has a tool named ${name}.`);
    }
    for (const [toolName, description] of Object.entries(wrappers)) {
      const name = wrappedName(toolName);
      if (registered.has(name)) continue;
      const { label, parameters, prepareArguments, executionMode } = tools.get(toolName);
      pi.registerTool({
        name, label: `Deeppi: ${label}`, description, parameters, prepareArguments, executionMode, defaultActive: false,
        async execute(id, args, signal, _onUpdate, ctx) {
          const state = current;
          if (!state?.bash || state.scope !== scopeOf(ctx) || !pi.getActiveTools().includes(name)) {
            throw new AppError(403, 'The Deeppi Bash add-on is disabled for this Pi session.');
          }
          const combined = signal ? AbortSignal.any([signal, state.controller.signal]) : state.controller.signal;
          const { tools, buildTools, registry } = state.bashTools;
          // Persist only the accepted definition; the shared helper rolls back if appendEntry throws.
          const selected = toolName === 'define_tool'
            ? buildTools(() => pi.appendEntry(definitionEntry, registry[args.name])).get(toolName)
            : tools.get(toolName);
          return selected.execute(id, args, combined);
        },
      });
      registered.add(name);
    }
  }

  async function prepareBash(ctx, scope, epoch) {
    loadBash ??= import('../bash-tools.mjs');
    const { createBashTools } = await loadBash;
    assertCurrent(ctx, scope, epoch);
    const registry = Object.create(null);
    const buildTools = (onRegistryChange = () => {}) => new Map(createBashTools({
      cwd: ctx.cwd, allowBash: true, bashTimeoutMs: 60_000, maxToolOutput: 12_000, registry, onRegistryChange,
    }).map(tool => [tool.name, tool]));
    const tools = buildTools();
    let accepted = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (owns(entry, toggleEntry) && entry.data?.id === 'bash') accepted = allowedBash(entry.data);
      if (accepted && owns(entry, definitionEntry)) {
        // Session logs are local input. Validate restored definitions without executing their scripts.
        try { await tools.get('define_tool').execute('restore', entry.data); } catch { /* Ignore malformed entries. */ }
      }
    }
    assertCurrent(ctx, scope, epoch);
    registerWrappers(tools);
    return { tools, buildTools, registry };
  }

  async function restore(ctx, scope, epoch) {
    if (current?.scope === scope) return;
    const previous = current;
    current = undefined;
    previous?.controller.abort();
    const branch = ctx.sessionManager.getBranch();
    const lastToggle = id => branch.findLast(entry => owns(entry, toggleEntry) && entry.data?.id === id)?.data;
    const state = { scope, compact: lastToggle('compact')?.enabled === true, bash: false, controller: new AbortController() };
    if (allowedBash(lastToggle('bash') ?? {})) {
      try {
        state.bashTools = await prepareBash(ctx, scope, epoch);
        activateBash(true);
        state.bash = true;
      } catch (error) {
        assertCurrent(ctx, scope, epoch);
        ctx.ui?.notify(`Could not restore the Deeppi Bash add-on: ${error.message}`, 'warning');
      }
    }
    if (!state.bash) activateBash(false);
    current = state;
  }

  const attach = ctx => schedule(ctx, (scope, epoch) => restore(ctx, scope, epoch));

  async function update(ctx, patch) {
    if (!plainObject(patch) || (patch.id !== 'compact' && patch.id !== 'bash')) throw new AppError(400, 'Unknown Deeppi add-on.');
    const { id, enabled, confirmed } = patch;
    if (typeof enabled !== 'boolean') throw new AppError(400, 'The enabled flag must be a boolean.');
    if (id === 'bash' && enabled && confirmed !== true) throw new AppError(400, 'Confirm local Bash execution before enabling this add-on.');
    return schedule(ctx, async (scope, epoch) => {
      waitForIdle(ctx);
      await restore(ctx, scope, epoch);
      assertCurrent(ctx, scope, epoch);
      if (current[id] === enabled) return snapshot();
      const state = current;
      if (id === 'bash' && enabled) {
        const bashTools = state.bashTools ?? await prepareBash(ctx, scope, epoch);
        assertCurrent(ctx, scope, epoch);
        waitForIdle(ctx);
        try {
          activateBash(true);
          pi.appendEntry(toggleEntry, { id, enabled, confirmed: true });
        } catch (error) {
          activateBash(false);
          throw error;
        }
        state.bashTools = bashTools;
      } else {
        waitForIdle(ctx);
        pi.appendEntry(toggleEntry, { id, enabled });
      }
      state[id] = enabled;
      if (id === 'bash' && !enabled) {
        state.controller.abort();
        state.controller = new AbortController();
        activateBash(false);
      }
      const changed = snapshot();
      pi.events?.emit('deeppi:addons-changed', changed);
      return snapshot();
    });
  }

  pi.on('session_start', (_event, ctx) => {
    closed = false;
    boundScope = scopeOf(ctx);
    invalidate();
    return attach(ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    invalidate();
    return attach(ctx);
  });
  pi.on('session_shutdown', () => {
    closed = true;
    invalidate();
  });

  pi.registerCommand('deeppi-addons', {
    description: 'List or change optional Deeppi add-ons for the active Pi session branch.',
    async handler(args, ctx) {
      const words = args.trim().split(/\s+/u);
      const [action, id] = words;
      if (words.length === 1 && (!action || action === 'list')) {
        const { compact, bash } = snapshot();
        ctx.ui.notify(`Deeppi add-ons: compact ${compact ? 'on' : 'off'}, bash ${bash ? 'on' : 'off'}. Use /deeppi-addons <enable|disable> <compact|bash>.`, 'info');
        return;
      }
      if (words.length !== 2 || !['enable', 'disable'].includes(action) || !['compact', 'bash'].includes(id)) {
        ctx.ui.notify('Usage: /deeppi-addons <enable|disable> <compact|bash>', 'warning');
        return;
      }
      const enabled = action === 'enable';
      const epoch = revision, scope = scopeOf(ctx);
      try {
        let confirmed;
        if (id === 'bash' && enabled) {
          if (!ctx.hasUI) throw new AppError(403, 'Enable the Bash add-on in an interactive Pi session or from Deeppi Web.');
          confirmed = await ctx.ui.confirm('Enable Deeppi Bash tools?', 'The model can define and run Bash scripts with your host user’s permissions. This is not a sandbox. Pi’s native Bash tool is unchanged.');
          if (confirmed !== true) return;
          assertCurrent(ctx, scope, epoch);
        }
        await update(ctx, { id, enabled, confirmed });
        ctx.ui.notify(`Deeppi ${id} add-on ${enabled ? 'enabled' : 'disabled'}.`, 'info');
      } catch (error) {
        ctx.ui.notify(error.message, 'warning');
      }
    },
  });

  pi.registerCommand('deeppi-compact', {
    description: 'Run native Pi compaction with optional Deeppi continuity guidance and a focus.',
    async handler(focus, ctx) {
      try {
        if (!snapshot().compact) throw new AppError(403, 'Enable the compact add-on with /deeppi-addons enable compact. Native /compact remains available.');
        waitForIdle(ctx);
        ctx.compact({
          customInstructions: compactInstructions(focus),
          onComplete: () => ctx.ui.notify('Pi compaction completed.', 'info'),
          onError: error => ctx.ui.notify(`Pi compaction failed: ${error.message}`, 'error'),
        });
      } catch (error) {
        ctx.ui.notify(error.message, 'warning');
      }
    },
  });

  return { attach, snapshot, update, compactInstructions };
}
