# Composer predictions · 输入预测

<img src="icon.svg" width="72" height="72" alt="输入预测图标" />

为 **DeepSeek Harness（DSH）** 提供类似 Codex 的下一条提示词推荐：助手回答结束后，根据当前对话生成一句推荐，以浅色文字显示在输入框内，按 **Tab** 填入可编辑草稿。不会自动发送。

[下载最新版本](https://github.com/boshihaihai/dsh-plugin-composer-predictions/releases/latest) · [反馈问题](https://github.com/boshihaihai/dsh-plugin-composer-predictions/issues) · [MIT License](LICENSE)

## 使用效果

- 回答结束约 350ms 后，在草稿为空时请求一次推荐；显示时间还取决于模型响应速度。
- 推荐沿用用户的语言和当前任务，优先给出一句简短、具体的下一步提示。
- 输入框内显示浅色推荐及「按 Tab 接受」提示。Tab 填入后可以修改，再自行发送。
- 输入、粘贴、拖入内容、中文输入法开始组字、按 Esc、发送或切换会话，都会取消当前推荐。清空草稿不会让刚忽略的推荐重新出现。
- Tab 只在输入框聚焦时接受推荐；工具栏、Shift+Tab、组合键及中文输入法继续保持原有行为。
- 「设置 → 通用 → 显示输入预测」控制开关，默认开启，保存在当前浏览器的 localStorage 中。

## 安装或更新

需要带 Web UI 的 DeepSeek Harness。插件沿用原版基于 DSH Desktop `2.0.17-beta.2` / dsh `0.2.1-alpha.2` 的接口；1.2.0 的验证范围见下文。

从 [Releases](https://github.com/boshihaihai/dsh-plugin-composer-predictions/releases/latest) 下载 `.tgz` 安装包。在 DSH 左侧 **插件 → 添加插件** 中填入下载文件的完整路径。更新第三方插件时，先卸载旧版，再安装新版。

本地打包后的安装包位置为：

```text
dist/dsh-plugin-composer-predictions-1.2.2.tgz
```

也可以通过 Harness Plugin Manager 安装：

```text
plugin_manager install_bundle target: <安装包的绝对路径>/dsh-plugin-composer-predictions-1.2.2.tgz
```

更新已安装插件后，**重启 DSH 一次**，让缓存的 Host 模块、客户端脚本和页面令牌一起更新。开发时可安装本目录；分享或正式使用推荐 `.tgz` 包。

## 1.2.2 改动

- 确定使用放大版蓝色提示符图标，透明背景沿用 DSH 的白底圆角外框，减少留白以提高列表中的辨识度。
- 以新版本安装包交付最终图标；功能代码不变。

## 1.2.1 改动

- 使用选定的 G 版提示符与分段下划线，表达提示词补全；采用透明背景、蓝色图形和统一留白，沿用 DSH 提供的白底圆角外框。
- 图标为独立 SVG，通过 `./icon` 导出并包含在安装包中，无外部图片、字体或脚本依赖；符合 DSH 的 256 KiB 图标大小上限。
- 本次仅更新图标与版本信息；功能验证沿用下述 1.2.0 结果。

## 1.2.0 改动

- 保护现有草稿，包括只有空格的草稿；等待请求期间开始输入也会立即取消。
- 关闭开关、新回合开始、切换会话和组件卸载时清理请求；迟到的结果不能覆盖当前推荐。
- 修复工具栏 Tab 和输入法组字时误接受推荐的问题；插入失败时保留原生 Tab 行为。
- 用 DOM/尺寸观察替代每 400ms 轮询，支持编辑器重新挂载；推荐换行时撑开输入框，窗口变宽后能缩回，清理后恢复原有高度和占位符。
- 推荐可由屏幕阅读器读取；视觉提示仍独立于编辑器，不会混入草稿。
- 优化上下文和生成指令，保留最新用户目标，减少泛泛的感谢、无关任务和无依据的偏好猜测。
- 校验模型配置并回退到有效历史配置或默认模型；请求提供超时和取消处理。
- 保留推荐中的引号、代码反引号等有效标点。超过 400 个 Unicode 字符时丢弃，不截出残缺提示词。

## 实现

无新增运行依赖，无需构建。Host 使用注入的 `llm`、`agents`、可选 `webServer`；客户端使用 `window.__ModuleLoader__` 和宿主注入的 React/slots/locale。

| 文件 | 用途 |
| --- | --- |
| `predict-server.js` | 注册 `POST /composer-predictions/predict`，读取会话、选择模型、发起辅助调用，返回 `{ suggestion, reason?, model?, debug? }`。 |
| `client.js` | 监听回答结束，管理请求、浅色推荐层、键盘事件和设置开关。 |
| `cordis.patch.yml` | 相对路径的 Cordis Host 注册项。 |
| `locale/*.json`、`icon.svg` | 插件展示信息。 |
| `test/` | 客户端、服务端回归测试和可选浏览器检查，不进入插件安装包。 |
| `assets/icon-preview.png` | 当前图标在白底圆角容器中的效果预览。 |
| `dist/` | 本地安装包及源码包，不提交到 Git；正式版本从 Releases 下载。 |

客户端通过宿主的 `InputActions.insertText(...)` 填入文本。推荐层是编辑器旁的只读 DOM 节点，不修改 Lexical 文档。它依赖宿主的 `[data-composer-input]`、`[data-composer-placeholder]`、`[data-composer-card]` 标记；宿主更改结构时可能需要适配。

预测采用当前会话模型，缺少有效配置时尝试历史请求和默认模型。上下文最多 18 条用户/助手消息、12k 字符，单条长消息保留首尾。推荐不写入 Session 日志。启用后每个符合条件的已结束回合最多增加一次模型调用，用户提前编辑或关闭功能会取消。

Host 为页面注入每次启动生成的 capability token，预测请求必须携带对应请求头。服务端整请求上限为 30 秒，客户端另有 35 秒等待上限；取消信号会传给模型服务，供应商是否立即停止后台计算取决于其实现。

## 验证

Node.js 22 或以上：

```bash
npm test
npm run check
npm run pack:plugin
```

1.2.0 在 2026-10-18 完成 48 项自动化回归检查（30 项客户端、18 项服务端），覆盖请求去重、草稿保护、取消与迟到结果、Tab/IME、编辑器重挂载、模型回退、鉴权、输出标点和超时。测试通过宿主服务/React hooks 的替身驱动插件实际入口，不调用真实模型。

另用本机 Chromium 验证了实际 DOM 的窄屏换行、宽屏高度恢复、原生观察器、编辑器重挂载、工具栏 Tab、输入框 Tab 和清理；无页面异常。浏览器检查仍使用测试 hooks 和模拟模型响应，**不代表已在运行中的 DSH 完成端到端验证**。

可选浏览器检查需要已有 Playwright 及 Chromium：

```bash
npm run test:browser
```

使用外部安装的 Playwright 时，可设置 `PLAYWRIGHT_MODULE` 为包目录；使用已有 Chromium 时，可设置 `PLAYWRIGHT_EXECUTABLE_PATH` 为浏览器可执行文件路径。这些只是测试依赖，安装插件不需要它们。

## 排查

- **安装后没有设置项或推荐**：先重启 DSH，确认插件已启用、已开启「显示输入预测」，然后在空草稿下完成一个新回合。打开已有空闲会话不会主动补发预测。
- **页面令牌缺失或 401**：页面仍使用旧 Host 的令牌，刷新页面或重启应用。
- **请求后没有推荐**：模型可能返回空结果、`SKIP`、超长输出或超时；插件静默放弃该次推荐，不自动重试。推理模型保留 1500 token 预算，但仍可能用完预算而没有可见输出。
- **需要调试状态**：在宿主页面的 localStorage 中设置 `dsh.composer-predictions.debug` 为 `1`，然后触发新回合。调试层会包含会话 ID、草稿与推荐文本，仅在本地排查时启用。

## License

欢迎通过 Issues 反馈问题，或提交 Pull Request。提交功能改动前请运行 `npm test` 和 `npm run check`，并在说明中注明验证范围。

MIT，见 [LICENSE](LICENSE)。本项目是受 Codex 输入预测交互启发的独立 DSH 插件。
