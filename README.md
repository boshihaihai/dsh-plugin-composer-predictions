# Composer Predictions · 输入预测

<img src="icon.svg" width="72" height="72" alt="输入预测图标" />

为 **DeepSeek Harness（DSH）** 推荐下一条提示词。助手回答结束后，推荐内容以浅色文字显示在输入框内，按 **Tab** 填入草稿，编辑后自行发送。

[下载插件](https://github.com/boshihaihai/dsh-plugin-composer-predictions/releases/latest) · [反馈问题](https://github.com/boshihaihai/dsh-plugin-composer-predictions/issues)

## 使用

- 根据当前对话生成推荐，沿用用户的语言。
- 仅在输入框为空时显示；开始输入或按 Esc 即可取消。
- 切换会话会隐藏建议并取消尚未完成的请求；返回时恢复该会话已生成、尚未接受的建议，不重复请求模型。
- 建议仅缓存在当前页面内存中（最多 100 个会话），刷新或重启后不保留。接受、忽略、编辑草稿、开始新一轮或关闭预测会清除相应建议。
- 在 **设置 → 通用 → 显示输入预测** 中开启或关闭，默认开启。
- 使用当前会话模型，每次推荐会增加一次模型请求。

## 安装

1. 从 [Releases](https://github.com/boshihaihai/dsh-plugin-composer-predictions/releases/latest) 下载 `.tgz` 安装包。
2. 在 DSH 左侧 **插件 → 添加插件** 中填入安装包的完整路径。
3. 安装并启用插件，然后重启 DSH。

更新时先卸载旧版，再安装新版。接口适配基于 DSH Desktop `2.0.17-beta.2` / dsh `0.2.1-alpha.2`。

若没有显示推荐，请确认插件和设置开关已开启，并在空草稿下完成一次新对话回复；模型未生成有效推荐或请求超时时不会显示。

## 开发

需要 Node.js 22 或以上，无新增运行依赖，无需构建。

```bash
npm test
npm run check
npm run pack:plugin
```

安装包输出到 `dist/`。欢迎提交 Issue 或 Pull Request。

## 许可

[MIT](LICENSE)。受 Codex 输入预测交互启发的独立 DSH 插件。
