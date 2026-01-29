# Clawdbot 企业微信（WeCom）Channel 插件

支持企业微信智能机器人（API 模式）加密回调 + 被动回复（stream），以及图片收发。

## 快速开始

### 1. 创建企业微信机器人

1. 登录[企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入「安全与管理」→「管理工具」→「创建机器人」
3. 选择「**API 模式创建**」
4. 填写回调 URL：`http://你的服务器:端口/wecom`
5. 点击「随机获取」生成 **Token** 和 **EncodingAESKey**，保存备用

> ⚠️ 中国内地服务器需完成 ICP 备案，或使用香港/海外服务器。

### 2. 安装插件

```bash
curl -sSL https://raw.githubusercontent.com/DouDOU-start/clawdbot-wechat/master/install.sh | bash
```

安装脚本会引导你完成配置，输入上一步保存的 Token 和 EncodingAESKey 即可。

### 3. 验证并使用

回到企业微信管理后台点击「保存」，验证通过后扫码添加机器人即可开始对话。

### 4. 后续更新

```bash
clawdbot-wecom update
```

其他命令：`clawdbot-wecom config`（重新配置）、`clawdbot-wecom status`（查看状态）

---

## 配置参数

配置文件位于 `~/.clawdbot/clawdbot.json`：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `webhookPath` | ✓ | Webhook 路径，默认 `/wecom` |
| `token` | ✓ | 企业微信后台生成的 Token |
| `encodingAESKey` | ✓ | 企业微信后台生成的 EncodingAESKey |
| `welcomeText` | | 用户首次进入时的欢迎语 |
| `corpId` | | 企业 ID（出站 API 用） |
| `agentId` | | 应用 AgentId（出站 API 用） |
| `secret` | | 应用 Secret（出站 API 用） |

---

## 图片功能

- **接收图片**：用户发送的图片会自动下载并传递给 AI（需模型支持多模态）
- **发送图片**：AI 回复中的图片 URL 会自动转换为图片发送（最多 10 张，单张最大 10MB）

---

## 常见问题

**Q: 验证回调地址失败？**
- 检查服务器公网可访问、端口已开放
- 检查 Token 和 EncodingAESKey 是否正确

**Q: 机器人不回复？**
- 查看 Clawdbot 日志确认是否有错误
- 检查 AI 模型配置是否正确

**Q: 一直显示「收到请稍后~」？**
- 这是 Stream 模式正常行为，企业微信会自动刷新获取完整回复

---

## 许可证

MIT
