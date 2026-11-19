# sub-usage-push

一个 Claude Code mod。它会把 Claude 订阅的 5 小时和 7 天限额（已用百分比和重置时间）推送到 [ai-plan-insight](https://github.com/FlintyLemming/ai-plan-insight) 面板上 `type: claude`、`mode: push` 的实例。

## 安装

在终端里的 Claude Code 会话中输入：

```text
/plugin install sub-usage-push --marketplace FlintyLemming/claude-usage-upload-mod
```

提示添加 marketplace 时输入 `y`，然后选择安装范围（推荐 user）。安装过程中会让你填写面板地址、实例 ID 和 token，之后也可以在 `/config` 里修改。三项都填好后才会开始上报。需要 Claude Code 2.1.326 或更新版本。

## 工作方式

- 每个主线程回合结束后，引擎会触发 `session.measure`。mod 从中读取 `five_hour` 和 `seven_day` 两个窗口，存进 `$.store`（所有会话共用），然后立即推送。
- 每个会话每 5 分钟会把最新读数再推一次，避免面板因为 30 分钟没收到推送而隐藏卡片。内容没变、且距上次推送不到 4.5 分钟时会跳过（不管上次是哪个会话推的）。
- 窗口过了重置时间但还没有新读数时，会按 0% 上报，重置时间保持原值。
- 数据来自最近一次 API 响应：只要有任意 Claude Code 会话在用，数据就是新的；完全空闲时会继续推最后一次读数。

## 从本地目录加载（开发用）

不通过 marketplace 安装、直接从克隆下来的目录加载时，在 `~/.claude/settings.json` 里写：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-usage-upload-mod"
  },
  "pluginConfigs": {
    "sub-usage-push": {
      "options": {
        "endpoint": "https://dashboard.example.com",
        "instanceId": "<面板上的实例 ID>",
        "token": "<push_auth_secret>"
      }
    }
  }
}
```

`CLAUDE_CODE_PLUGIN_DIRS` 让之后新开的每个会话（终端、桌面 app、`claude -p`）都加载这个 mod。

## 开发

需要用 2.1.326 及以上版本的 `claude`，旧版不认识 `hooks.json` 里的 `modules`。

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

推送状态保存在 `~/.claude/plugins/store/` 下以 `sub-usage-push` 开头的文件里，`lastPush.at` 是最后一次成功推送的时间。
