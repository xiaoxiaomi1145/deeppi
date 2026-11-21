import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, SessionManager, getAgentDir, parseFrontmatter, stripFrontmatter, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { createPiAddons } from '../server/pi/addons.mjs';
import { createPiCatalog } from '../server/pi/catalog.mjs';
import { registerPiEnvironment } from '../server/pi/environment.mjs';
import { createPiHost } from '../server/pi/host.mjs';
import { getPiWebHub } from '../server/pi/hub.mjs';
import { createPiResources } from '../server/pi/resources.mjs';
import { projectBranch } from '../server/pi/transcript.mjs';
import { createWebModels } from '../server/pi/web-models.mjs';
import { getQqService } from '../server/qq/service.mjs';

export default function deeppi(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const distDir = fileURLToPath(new URL('../dist/pi/', import.meta.url));
  const hub = getPiWebHub({ agentDir, distDir });
  const addons = createPiAddons(pi);
  const resources = createPiResources({ pi, agentDir, configDirName: CONFIG_DIR_NAME, parseFrontmatter });
  const catalog = createPiCatalog({ SessionManager, projectBranch });
  const allowEnvironmentModel = registerPiEnvironment(pi);
  const qq = getQqService({ agentDir, cleanupSession: cleanupSessionResources });
  const webModels = createWebModels({ pi, agentDir });
  const host = createPiHost({ pi, addons, resources, catalog, hub, thinkingLevels: getSupportedThinkingLevels,
    clampThinking: clampThinkingLevel, allowEnvironmentModel, qq, webModels, stripFrontmatter });

  pi.registerCommand('deeppi', {
    description: 'Open the Deeppi web view of this Pi session; /deeppi close stops the listener',
    async handler(args, ctx) {
      const action = args.trim();
      if (action === 'close') {
        await hub.close();
        ctx.ui.notify('Deeppi 网页服务已关闭。', 'info');
        return;
      }
      if (action) { ctx.ui.notify('用法：/deeppi 或 /deeppi close', 'warning'); return; }
      host.bindCommands(ctx);
      try {
        const url = await hub.start(Number(process.env.DEEPPI_PI_PORT || 0));
        ctx.ui.notify(`Deeppi · ${url}`, 'info');
      } catch (cause) {
        const error = cause as { status?: number; code?: string; message?: string };
        ctx.ui.notify(error?.status ? error.message || 'Deeppi 未能启动。'
          : error?.code === 'EADDRINUSE' ? 'Deeppi 网页端口已被占用。'
            : 'Deeppi 未能启动本机网页服务。', 'error');
      }
    },
  });
}
