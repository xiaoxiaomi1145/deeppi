# DeepSeek chat-demo reuse

DeepSeek chat-demo is distributed under the MIT License. Upstream revision [8ad7b56e196b87d8a3215dc09476d6d146ad3f0e](https://github.com/deepseek-ai/chat-demo/tree/8ad7b56e196b87d8a3215dc09476d6d146ad3f0e). Copyright (c) 2026 DeepSeek. [MIT license](<upstream/LICENSE>).

| Deeppi source | Original chat-demo source |
| --- | --- |
| [theme.css](<upstream/theme.css>), [global.css](<upstream/global.css>), [App.module.css](<upstream/App.module.css>) | `src/app/{theme.css,global.css,App.module.css}` |
| [Sider.module.css](<upstream/Sider.module.css>), [SessionItem.module.css](<upstream/SessionItem.module.css>) | `src/components/sider/{Sider,SessionItem}.module.css` |
| [SessionView.module.css](<upstream/SessionView.module.css>), [Welcome.module.css](<upstream/Welcome.module.css>) | `src/components/session/{SessionView,Welcome}.module.css` |
| [ChatInput.module.css](<upstream/ChatInput.module.css>) | `src/components/chatInput/ChatInput.module.css` |
| [Button.tsx](<upstream/Button.tsx>), [Button.module.css](<upstream/Button.module.css>), [IconButton.tsx](<upstream/IconButton.tsx>), [IconButton.module.css](<upstream/IconButton.module.css>), [icons.tsx](<upstream/icons.tsx>) | `src/components/base/` |
| [markdown.css](<upstream/markdown.css>) | `src/components/markdown/markdown.css` |

The icon button uses an accessible native label and tooltip. Deeppi uses the vendored CSS and inline SVGs with its own session state, composer controls, settings and context panels. Markdown parsing is provided by React Markdown and remark-gfm.
